"""Versioned, loopback-only EDA Studio orchestration API."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import os
import re
import secrets
import stat
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Request
from fastapi import Path as ApiPath
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.exceptions import HTTPException as StarletteHTTPException

from edastack import __version__
from edastack.adapters.tscircuit import TscircuitBuildError, build_tscircuit_project
from edastack.studio.contracts import (
    BuildManifest,
    CompileResponse,
    ErrorResponse,
    HealthResponse,
    ProjectDetailResponse,
    ProjectListResponse,
    ProjectSourceFile,
    ProjectSummary,
    SessionResponse,
    ToolchainResponse,
)
from edastack.studio.toolchain import detect_toolchain

_LOG = logging.getLogger(__name__)
_PROJECT_ID_PATTERN = r"^[a-z][a-z0-9-]{0,62}$"
_MAX_BUILD_MANIFEST_BYTES = 1024 * 1024
_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
_MAX_PROJECT_MANIFEST_BYTES = 64 * 1024


@dataclass(frozen=True)
class StudioSettings:
    workspace_root: Path | None = None
    worker_root: Path | None = None
    compile_timeout_ms: int = 60_000
    allowed_origins: tuple[str, ...] = ()

    @classmethod
    def from_environment(cls) -> "StudioSettings":
        workspace = os.environ.get("EDA_STUDIO_WORKSPACE_ROOT")
        worker = os.environ.get("EDA_STUDIO_TSCIRCUIT_WORKER_ROOT")
        origins = tuple(
            origin.strip()
            for origin in os.environ.get("EDA_STUDIO_ALLOWED_ORIGINS", "").split(",")
            if origin.strip()
        )
        return cls(
            workspace_root=Path(workspace).expanduser() if workspace else None,
            worker_root=Path(worker).expanduser() if worker else None,
            allowed_origins=origins,
        )


class StudioAPIError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: list[str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def _parse_authority(value: str) -> tuple[str, int | None] | None:
    try:
        parsed = urlsplit("//" + value)
        if parsed.username is not None or parsed.password is not None or parsed.path or parsed.query or parsed.fragment:
            return None
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return None
    if not hostname:
        return None
    return hostname.lower().rstrip("."), port


def _is_loopback_authority(value: str) -> bool:
    parsed = _parse_authority(value)
    if parsed is None:
        return False
    hostname, _ = parsed
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _origin_allowed(origin: str, host: str, configured: tuple[str, ...]) -> bool:
    if origin == "null":
        return False
    if origin in configured:
        try:
            configured_origin = urlsplit(origin)
        except ValueError:
            return False
        return (
            configured_origin.scheme == "http"
            and not configured_origin.path
            and not configured_origin.query
            and not configured_origin.fragment
            and _is_loopback_authority(configured_origin.netloc)
        )
    try:
        parsed_origin = urlsplit(origin)
        origin_authority = _parse_authority(parsed_origin.netloc)
    except ValueError:
        return False
    host_authority = _parse_authority(host)
    if parsed_origin.scheme != "http" or not origin_authority or not host_authority:
        return False
    origin_host, origin_port = origin_authority
    host_name, host_port = host_authority
    return origin_host == host_name and (origin_port or 80) == (host_port or 80)


def _error_content(
    request_id: str,
    code: str,
    message: str,
    details: list[str] | None = None,
) -> dict[str, object]:
    return ErrorResponse(
        error={"code": code, "message": message, "request_id": request_id, "details": details}
    ).model_dump(exclude_none=True)


def _http_error_response(
    request: Request,
    status_code: int,
    code: str,
    message: str,
    details: list[str] | None = None,
) -> JSONResponse:
    request_id = getattr(request.state, "request_id", uuid.uuid4().hex)
    return JSONResponse(
        status_code=status_code,
        content=_error_content(request_id, code, message, details),
        headers={"X-Request-ID": request_id},
    )


def _safe_directory(path: Path, root: Path) -> Path:
    try:
        info = path.lstat()
    except FileNotFoundError:
        path.mkdir()
        info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise StudioAPIError(400, "PROJECT_PATH_UNSAFE", "Workspace paths must be regular directories.")
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise StudioAPIError(400, "PROJECT_PATH_UNSAFE", "Workspace paths must remain inside the configured root.")
    return resolved


def _workspace_root(settings: StudioSettings) -> Path:
    if settings.workspace_root is None:
        raise StudioAPIError(
            503, "WORKSPACE_NOT_CONFIGURED", "Set EDA_STUDIO_WORKSPACE_ROOT before opening projects."
        )
    try:
        workspace_root = settings.workspace_root.expanduser().resolve(strict=True)
    except OSError:
        raise StudioAPIError(503, "WORKSPACE_NOT_CONFIGURED", "The configured workspace root is unavailable.") from None
    if not workspace_root.is_dir():
        raise StudioAPIError(503, "WORKSPACE_NOT_CONFIGURED", "The configured workspace root is unavailable.")
    return workspace_root


def _project_root(workspace_root: Path, project_id: str) -> Path:
    candidate = workspace_root / project_id
    try:
        info = candidate.lstat()
    except FileNotFoundError:
        raise StudioAPIError(404, "PROJECT_NOT_FOUND", "The requested project was not found.") from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise StudioAPIError(400, "PROJECT_PATH_UNSAFE", "The project must be a regular directory inside the workspace.")
    project_root = candidate.resolve(strict=True)
    if not project_root.is_relative_to(workspace_root):
        raise StudioAPIError(400, "PROJECT_PATH_UNSAFE", "The project must remain inside the configured workspace.")
    return project_root


def _project_source_files(project_root: Path) -> list[ProjectSourceFile]:
    source_root = project_root / "src"
    try:
        source_info = source_root.lstat()
    except OSError:
        return []
    if stat.S_ISLNK(source_info.st_mode) or not stat.S_ISDIR(source_info.st_mode):
        return []

    files: list[ProjectSourceFile] = []
    for current, directories, names in os.walk(source_root, followlinks=False):
        current_path = Path(current)
        directories[:] = [name for name in directories if not (current_path / name).is_symlink()]
        for name in names:
            path = current_path / name
            if path.suffix.lower() not in {".ts", ".tsx"} or path.is_symlink() or not path.is_file():
                continue
            try:
                relative = path.relative_to(project_root).as_posix()
                files.append(ProjectSourceFile(path=relative, bytes=path.stat().st_size))
            except (OSError, ValueError):
                continue
            if len(files) > 500:
                return []
    return sorted(files, key=lambda source: source.path)


def _project_detail(workspace_root: Path, project_id: str) -> ProjectDetailResponse | None:
    try:
        project_root = _project_root(workspace_root, project_id)
        manifest_path = project_root / "eda.project.json"
        manifest_info = manifest_path.lstat()
        if (
            stat.S_ISLNK(manifest_info.st_mode)
            or not stat.S_ISREG(manifest_info.st_mode)
            or manifest_info.st_size > _MAX_PROJECT_MANIFEST_BYTES
        ):
            return None
        manifest = json.loads(manifest_path.read_bytes(), object_pairs_hook=_unique_json_object)
    except (OSError, ValueError, RecursionError, StudioAPIError):
        return None
    if not isinstance(manifest, dict) or manifest.get("project_id") != project_id:
        return None
    if manifest.get("schema_version") != 1 or manifest.get("authoring_backend") != "tscircuit":
        return None
    entrypoint = manifest.get("entrypoint")
    sources = _project_source_files(project_root)
    if not isinstance(entrypoint, str) or entrypoint not in {source.path for source in sources}:
        return None
    display_name = manifest.get("name")
    if not isinstance(display_name, str) or not display_name.strip():
        display_name = project_id
    try:
        return ProjectDetailResponse(
            project_id=project_id,
            name=display_name.strip()[:128],
            entrypoint=entrypoint,
            source_file_count=len(sources),
            source_files=sources,
        )
    except Exception:
        return None


def _project_directory(settings: StudioSettings, project_id: str) -> tuple[Path, Path]:
    workspace_root = _workspace_root(settings)
    project_root = _project_root(workspace_root, project_id)

    studio_root = _safe_directory(workspace_root / ".eda-studio", workspace_root)
    builds_root = _safe_directory(studio_root / "builds", workspace_root)
    project_builds = _safe_directory(builds_root / project_id, workspace_root)
    output_dir = project_builds / uuid.uuid4().hex
    return project_root, output_dir


def _verify_artifact_tree(output_dir: Path, manifest: BuildManifest) -> None:
    indexed = set(manifest.artifacts)
    actual: set[str] = set()
    total_bytes = 0
    for current, directories, files in os.walk(output_dir, followlinks=False):
        current_path = Path(current)
        for name in directories:
            if (current_path / name).is_symlink():
                raise StudioAPIError(502, "BUILD_MANIFEST_INVALID", "The compiler returned an unsafe artifact tree.")
        for name in files:
            path = current_path / name
            relative = path.relative_to(output_dir).as_posix()
            if path.is_symlink() or not path.is_file():
                raise StudioAPIError(502, "BUILD_MANIFEST_INVALID", "The compiler returned an unsafe artifact tree.")
            if relative == "build-manifest.json":
                continue
            actual.add(relative)
            expected = manifest.artifacts.get(relative)
            if expected is None:
                raise StudioAPIError(502, "BUILD_MANIFEST_INVALID", "The compiler returned an unindexed artifact.")
            digest = hashlib.sha256()
            size = 0
            with path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    size += len(chunk)
                    total_bytes += len(chunk)
                    if total_bytes > _MAX_ARTIFACT_BYTES:
                        raise StudioAPIError(502, "BUILD_MANIFEST_INVALID", "Compiler artifacts exceed the API size limit.")
                    digest.update(chunk)
            if size != expected.bytes or digest.hexdigest() != expected.sha256:
                raise StudioAPIError(502, "BUILD_MANIFEST_INVALID", "The compiler artifact hash verification failed.")
    if actual != indexed:
        raise StudioAPIError(502, "BUILD_MANIFEST_INVALID", "The compiler manifest does not index every artifact.")


def _verify_source_files(project_root: Path, manifest: BuildManifest) -> None:
    root = project_root.resolve(strict=True)
    for source in manifest.source_files:
        path = root
        for part in PurePosixPath(source.path).parts:
            path = path / part
            try:
                info = path.lstat()
            except OSError:
                raise StudioAPIError(
                    502, "BUILD_MANIFEST_INVALID", "The compiler referenced a missing project source file."
                ) from None
            if stat.S_ISLNK(info.st_mode):
                raise StudioAPIError(
                    502, "BUILD_MANIFEST_INVALID", "The compiler referenced an unsafe project source file."
                )
        try:
            resolved = path.resolve(strict=True)
        except OSError:
            raise StudioAPIError(
                502, "BUILD_MANIFEST_INVALID", "The compiler referenced a missing project source file."
            ) from None
        if not resolved.is_relative_to(root) or not resolved.is_file():
            raise StudioAPIError(
                502, "BUILD_MANIFEST_INVALID", "The compiler referenced an unsafe project source file."
            )
        digest = hashlib.sha256()
        size = 0
        try:
            with resolved.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    size += len(chunk)
                    digest.update(chunk)
        except OSError:
            raise StudioAPIError(
                502, "BUILD_MANIFEST_INVALID", "The compiler could not verify a project source file."
            ) from None
        if size != source.bytes or digest.hexdigest() != source.sha256:
            raise StudioAPIError(
                502, "BUILD_MANIFEST_INVALID", "The compiler source provenance does not match the project."
            )


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON object key")
        value[key] = item
    return value


def create_app(
    *,
    settings: StudioSettings | None = None,
    compiler: Callable[..., object] | None = None,
    toolchain_provider: Callable[[], ToolchainResponse] | None = None,
) -> FastAPI:
    config = settings or StudioSettings.from_environment()
    compile_project = compiler or build_tscircuit_project
    read_toolchain = toolchain_provider or detect_toolchain
    application = FastAPI(
        title="EDA Studio API",
        version="1.0.0",
        openapi_url="/api/v1/openapi.json",
        docs_url="/api/v1/docs",
        redoc_url=None,
    )
    application.state.session_token = secrets.token_urlsafe(32)
    bearer_scheme = HTTPBearer(
        auto_error=False,
        scheme_name="HTTPBearer",
        description="Per-process local token returned by GET /api/v1/session.",
    )

    @application.middleware("http")
    async def local_request_guard(request: Request, call_next):
        request_id = uuid.uuid4().hex
        request.state.request_id = request_id
        host = request.headers.get("host", "")
        if not _is_loopback_authority(host):
            response = _http_error_response(
                request, 403, "HOST_NOT_ALLOWED", "Studio accepts loopback Host headers only."
            )
        else:
            origin = request.headers.get("origin")
            if origin and not _origin_allowed(origin, host, config.allowed_origins):
                response = _http_error_response(
                    request, 403, "ORIGIN_NOT_ALLOWED", "The request Origin is not allowed."
                )
            else:
                response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        response.headers["Cache-Control"] = "no-store"
        return response

    @application.exception_handler(StudioAPIError)
    async def studio_api_error_handler(request: Request, exc: StudioAPIError) -> JSONResponse:
        return _http_error_response(request, exc.status_code, exc.code, exc.message, exc.details)

    @application.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        if exc.status_code == 404:
            code, message = "NOT_FOUND", "The requested API route was not found."
        elif exc.status_code == 405:
            code, message = "METHOD_NOT_ALLOWED", "The HTTP method is not supported for this route."
        else:
            code, message = "HTTP_ERROR", "The API request could not be completed."
        return _http_error_response(request, exc.status_code, code, message)

    @application.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        fields = sorted(
            {
                ".".join(str(part) for part in error.get("loc", ()) if part not in {"body", "query", "path"})
                for error in exc.errors()
            }
        )
        return _http_error_response(
            request,
            422,
            "INVALID_REQUEST",
            "The request does not match the API contract.",
            [field for field in fields if field],
        )

    @application.exception_handler(Exception)
    async def internal_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        request_id = getattr(request.state, "request_id", "unknown")
        _LOG.exception("Unhandled Studio API error request_id=%s", request_id)
        return _http_error_response(request, 500, "INTERNAL_ERROR", "The API could not complete the request.")

    def require_session(
        request: Request,
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    ) -> None:
        if not credentials or credentials.scheme.lower() != "bearer":
            raise StudioAPIError(401, "AUTH_REQUIRED", "A local Studio session token is required.")
        if not secrets.compare_digest(credentials.credentials, request.app.state.session_token):
            raise StudioAPIError(401, "AUTH_REQUIRED", "A valid local Studio session token is required.")

    @application.get(
        "/api/v1/health",
        response_model=HealthResponse,
        tags=["system"],
        responses={403: {"model": ErrorResponse}},
    )
    def health() -> HealthResponse:
        return HealthResponse(build_version=__version__)

    @application.get(
        "/api/v1/toolchain",
        response_model=ToolchainResponse,
        tags=["system"],
        responses={403: {"model": ErrorResponse}},
    )
    def toolchain() -> ToolchainResponse:
        return read_toolchain()

    @application.get(
        "/api/v1/session",
        response_model=SessionResponse,
        tags=["system"],
        responses={403: {"model": ErrorResponse}},
    )
    def session() -> SessionResponse:
        return SessionResponse(session_token=application.state.session_token)

    @application.get(
        "/api/v1/projects",
        response_model=ProjectListResponse,
        tags=["projects"],
        operation_id="list_projects",
    )
    def projects() -> ProjectListResponse:
        if config.workspace_root is None:
            return ProjectListResponse(workspace_status="not_configured", projects=[])
        try:
            workspace_root = _workspace_root(config)
            children = sorted(workspace_root.iterdir(), key=lambda path: path.name.casefold())
        except (OSError, StudioAPIError):
            return ProjectListResponse(workspace_status="unavailable", projects=[])
        project_summaries = []
        for child in children:
            if not re.fullmatch(_PROJECT_ID_PATTERN, child.name):
                continue
            try:
                info = child.lstat()
            except OSError:
                continue
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                continue
            detail = _project_detail(workspace_root, child.name)
            if detail is not None:
                project_summaries.append(
                    ProjectSummary(
                        project_id=detail.project_id,
                        name=detail.name,
                        entrypoint=detail.entrypoint,
                        source_file_count=detail.source_file_count,
                    )
                )
        return ProjectListResponse(
            workspace_status="available",
            workspace_name=workspace_root.name,
            projects=project_summaries,
        )

    @application.get(
        "/api/v1/projects/{project_id}",
        response_model=ProjectDetailResponse,
        tags=["projects"],
        operation_id="get_project",
        responses={404: {"model": ErrorResponse}, 422: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
    )
    def project_detail(project_id: str = ApiPath(pattern=_PROJECT_ID_PATTERN)) -> ProjectDetailResponse:
        workspace_root = _workspace_root(config)
        detail = _project_detail(workspace_root, project_id)
        if detail is None:
            raise StudioAPIError(404, "PROJECT_NOT_FOUND", "The requested project was not found in the workspace.")
        return detail

    @application.post(
        "/api/v1/projects/{project_id}/compile",
        response_model=CompileResponse,
        tags=["compile spike"],
        operation_id="compile_project",
        responses={
            400: {"model": ErrorResponse},
            401: {"model": ErrorResponse},
            403: {"model": ErrorResponse},
            404: {"model": ErrorResponse},
            422: {"model": ErrorResponse},
            502: {"model": ErrorResponse},
            503: {"model": ErrorResponse},
        },
    )
    def compile_project_route(
        project_id: str = ApiPath(pattern=_PROJECT_ID_PATTERN),
        _authorized: None = Depends(require_session),
    ) -> CompileResponse:
        project_root, output_dir = _project_directory(config, project_id)
        try:
            result = compile_project(
                project_root,
                output_dir,
                worker_root=config.worker_root,
                timeout_ms=config.compile_timeout_ms,
            )
        except TscircuitBuildError as exc:
            raise StudioAPIError(
                422,
                "BUILD_FAILED",
                "The sandboxed compiler could not compile this project.",
                [exc.code],
            ) from None
        except OSError:
            raise StudioAPIError(503, "BUILD_UNAVAILABLE", "The sandboxed compiler could not be started.") from None

        manifest_path = output_dir / "build-manifest.json"
        reported_path = Path(getattr(result, "manifest_path", ""))
        try:
            if reported_path.is_symlink() or reported_path.resolve(strict=True) != manifest_path.resolve(strict=True):
                raise StudioAPIError(502, "BUILD_MANIFEST_INVALID", "The compiler returned an invalid manifest location.")
            manifest_bytes = manifest_path.read_bytes()
        except FileNotFoundError:
            raise StudioAPIError(502, "BUILD_MANIFEST_INVALID", "The compiler did not return a build manifest.") from None
        if len(manifest_bytes) > _MAX_BUILD_MANIFEST_BYTES:
            raise StudioAPIError(502, "BUILD_MANIFEST_INVALID", "The compiler manifest exceeds the API size limit.")
        try:
            manifest_data = json.loads(manifest_bytes, object_pairs_hook=_unique_json_object)
            manifest = BuildManifest.model_validate(manifest_data)
        except Exception:
            raise StudioAPIError(502, "BUILD_MANIFEST_INVALID", "The compiler returned a malformed build manifest.") from None
        _verify_source_files(project_root, manifest)
        _verify_artifact_tree(output_dir, manifest)
        return CompileResponse(
            **manifest.model_dump(),
            project_id=project_id,
            build_id=output_dir.name,
            manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        )

    return application


app = create_app()
