"""Versioned, loopback-only EDA Studio orchestration API."""

from __future__ import annotations

import hashlib
import ipaddress
import logging
import os
import re
import secrets
import stat
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Path as ApiPath, Request
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
    SessionResponse,
    ToolchainResponse,
)
from edastack.studio.toolchain import detect_toolchain

_LOG = logging.getLogger(__name__)
_PROJECT_ID_PATTERN = r"^[a-z][a-z0-9-]{0,62}$"
_MAX_BUILD_MANIFEST_BYTES = 1024 * 1024
_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024


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


def _project_directory(settings: StudioSettings, project_id: str) -> tuple[Path, Path]:
    if settings.workspace_root is None:
        raise StudioAPIError(503, "WORKSPACE_NOT_CONFIGURED", "Set EDA_STUDIO_WORKSPACE_ROOT before compiling projects.")
    try:
        workspace_root = settings.workspace_root.expanduser().resolve(strict=True)
    except OSError:
        raise StudioAPIError(503, "WORKSPACE_NOT_CONFIGURED", "The configured workspace root is unavailable.") from None
    if not workspace_root.is_dir():
        raise StudioAPIError(503, "WORKSPACE_NOT_CONFIGURED", "The configured workspace root is unavailable.")

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
            manifest = BuildManifest.model_validate_json(manifest_bytes)
        except Exception:
            raise StudioAPIError(502, "BUILD_MANIFEST_INVALID", "The compiler returned a malformed build manifest.") from None
        _verify_artifact_tree(output_dir, manifest)
        return CompileResponse(
            **manifest.model_dump(),
            project_id=project_id,
            build_id=output_dir.name,
            manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        )

    return application


app = create_app()
