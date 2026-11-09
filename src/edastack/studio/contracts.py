"""Versioned request and response models shared by the Studio API."""

from __future__ import annotations

from datetime import datetime
from pathlib import PurePosixPath
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ErrorCode = Literal[
    "HOST_NOT_ALLOWED",
    "ORIGIN_NOT_ALLOWED",
    "AUTH_REQUIRED",
    "WORKSPACE_NOT_CONFIGURED",
    "PROJECT_PATH_UNSAFE",
    "PROJECT_NOT_FOUND",
    "BUILD_FAILED",
    "BUILD_UNAVAILABLE",
    "BUILD_MANIFEST_INVALID",
    "NOT_FOUND",
    "METHOD_NOT_ALLOWED",
    "HTTP_ERROR",
    "INVALID_REQUEST",
    "INTERNAL_ERROR",
]


def _safe_relative_path(value: str) -> str:
    if not value or "\\" in value or value.startswith("/") or ":" in value:
        raise ValueError("path must be a non-empty POSIX relative path")
    parsed = PurePosixPath(value)
    if parsed.is_absolute() or any(part in {"", ".", ".."} for part in value.split("/")):
        raise ValueError("path must not escape its artifact root")
    if parsed.as_posix() != value:
        raise ValueError("path must use canonical separators")
    return value


class ErrorDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: ErrorCode
    message: str = Field(min_length=1, max_length=240)
    request_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    details: list[str] | None = None


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    error: ErrorDetail


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    service: Literal["eda-studio-api"] = "eda-studio-api"
    status: Literal["ok"] = "ok"
    api_version: Literal["v1"] = "v1"
    build_version: str = Field(min_length=1)


class SessionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    session_token: str = Field(min_length=32)


class ToolchainEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["available", "unavailable", "error"]
    version: str | None = None
    reason: str | None = None


class ToolchainResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    checked_at_utc: datetime
    tools: dict[str, ToolchainEntry]


class SourceFileDigest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    bytes: int = Field(ge=0)

    @field_validator("path")
    @classmethod
    def path_is_relative(cls, value: str) -> str:
        return _safe_relative_path(value)


class SourceGraphCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    components: int = Field(ge=0)
    ports: int = Field(ge=0)
    nets: int = Field(ge=0)


class BuildToolchain(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node: str = Field(min_length=1)
    tscircuit: str = Field(min_length=1)
    react: str = Field(min_length=1)
    compiler_runtime: str = Field(min_length=1)
    compiler_lock_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    sandbox_image: str = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    circuit_json_to_kicad: str = Field(min_length=1)
    worker: str = Field(min_length=1)


class PartsVerification(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str = Field(min_length=1)
    unresolved: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class ArtifactDigest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    bytes: int = Field(ge=0)


class BuildManifest(BaseModel):
    """The worker's bounded, path-free build manifest contract."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    status: Literal["compiled"]
    project_name: str = Field(min_length=1, max_length=128)
    entrypoint: str
    created_at_utc: datetime
    source_files: list[SourceFileDigest]
    source_graph_counts: SourceGraphCounts
    toolchain: BuildToolchain
    circuit_json_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_graph_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    parts_verification: PartsVerification
    kicad_export_files: list[str]
    artifacts: dict[str, ArtifactDigest]

    @field_validator("entrypoint")
    @classmethod
    def entrypoint_is_relative(cls, value: str) -> str:
        return _safe_relative_path(value)

    @field_validator("kicad_export_files")
    @classmethod
    def export_paths_are_relative(cls, values: list[str]) -> list[str]:
        return [_safe_relative_path(value) for value in values]

    @model_validator(mode="after")
    def artifact_keys_are_relative(self) -> BuildManifest:
        for path in self.artifacts:
            _safe_relative_path(path)
        return self


class CompileResponse(BuildManifest):
    project_id: str = Field(pattern=r"^[a-z][a-z0-9-]{0,62}$")
    build_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    manifest_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
