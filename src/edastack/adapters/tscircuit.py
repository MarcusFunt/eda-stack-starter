"""Safe subprocess adapter for the pinned, sandboxed tscircuit project worker."""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

_MAX_OUTPUT_BYTES = 1024 * 1024
_MIN_BUILD_TIMEOUT_MS = 1_000
_MAX_BUILD_TIMEOUT_MS = 120_000
_ADAPTER_GRACE_SECONDS = 30
_HASH_RE = re.compile(r"^[a-f0-9]{64}$")
_ERROR_CODE_RE = re.compile(r"^([A-Z][A-Z0-9_]+):")


class TscircuitBuildError(RuntimeError):
    """A structured failure returned by the tscircuit project worker."""

    def __init__(self, code: str, message: str, returncode: int | None = None):
        super().__init__(message)
        self.code = code
        self.returncode = returncode


@dataclass(frozen=True)
class TscircuitBuildResult:
    """Paths and source graph counts produced by a successful worker build."""

    project_name: str
    output_dir: Path
    circuit_json_path: Path
    source_graph_path: Path
    source_manifest_path: Path
    kicad_output_dir: Path
    manifest_path: Path
    circuit_json_sha256: str
    component_count: int
    net_count: int


def _parse_worker_payload(output: str) -> dict[str, object] | None:
    if len(output.encode("utf-8", errors="replace")) > _MAX_OUTPUT_BYTES:
        return None
    try:
        payload = json.loads(output)
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict):
        return payload
    for line in reversed(output.splitlines()):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    return None


def _required_path(payload: dict[str, object], key: str) -> Path:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise TscircuitBuildError("TSCIRCUIT_PROTOCOL_ERROR", f"worker response is missing {key}")
    return Path(value)


def build_tscircuit_project(
    project_root: str | Path,
    output_dir: str | Path,
    *,
    worker_root: str | Path | None = None,
    entrypoint: str | None = None,
    timeout_ms: int = 60_000,
    node_executable: str = "node",
) -> TscircuitBuildResult:
    """Build a TSX project through the pinned Docker-isolated worker.

    The worker performs source snapshot validation, dependency allow-listing,
    container execution, Circuit JSON validation, canonical graph generation,
    and KiCad export. This adapter only invokes its CLI and parses its bounded
    machine-readable result; it never invokes a shell.
    """

    if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool):
        raise ValueError("timeout_ms must be an integer")
    if not _MIN_BUILD_TIMEOUT_MS <= timeout_ms <= _MAX_BUILD_TIMEOUT_MS:
        raise ValueError("timeout_ms must be between 1000 and 120000")
    if entrypoint is not None and (not isinstance(entrypoint, str) or not entrypoint.strip()):
        raise ValueError("entrypoint must be a non-empty project-relative path")

    project_path = Path(project_root).expanduser().resolve()
    output_path = Path(output_dir).expanduser().resolve()
    package_path = (
        Path(worker_root).expanduser().resolve()
        if worker_root is not None
        else Path(__file__).resolve().parents[3] / "packages" / "tscircuit-worker"
    )
    if not package_path.is_dir():
        raise TscircuitBuildError("TSCIRCUIT_WORKER_MISSING", f"worker package does not exist: {package_path}")

    command = [
        node_executable,
        "--import",
        "tsx",
        "src/build-cli.ts",
        "--project-root",
        str(project_path),
        "--output-dir",
        str(output_path),
        "--timeout-ms",
        str(timeout_ms),
    ]
    if entrypoint is not None:
        command.extend(["--entrypoint", entrypoint])
    try:
        completed = subprocess.run(
            command,
            cwd=package_path,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_ms / 1000 + _ADAPTER_GRACE_SECONDS,
            check=False,
            shell=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise TscircuitBuildError(
            "TSCIRCUIT_ADAPTER_TIMEOUT",
            f"worker process exceeded the {timeout_ms} ms build limit plus adapter cleanup allowance",
        ) from exc
    except OSError as exc:
        raise TscircuitBuildError("TSCIRCUIT_EXECUTION_FAILED", f"could not start worker: {exc}") from exc

    if len(completed.stdout.encode("utf-8", errors="replace")) > _MAX_OUTPUT_BYTES or len(
        completed.stderr.encode("utf-8", errors="replace")
    ) > _MAX_OUTPUT_BYTES:
        raise TscircuitBuildError("TSCIRCUIT_OUTPUT_LIMIT", "worker response exceeded the 1 MiB adapter limit", completed.returncode)

    payload = _parse_worker_payload(completed.stdout)
    if completed.returncode != 0:
        diagnostic = _parse_worker_payload(completed.stderr)
        error = diagnostic.get("error") if diagnostic else None
        message = error if isinstance(error, str) else completed.stderr.strip() or completed.stdout.strip()
        if not message:
            message = f"worker exited with status {completed.returncode}"
        match = _ERROR_CODE_RE.match(message)
        code = match.group(1) if match else "TSCIRCUIT_BUILD_FAILED"
        raise TscircuitBuildError(code, message, completed.returncode)
    if payload is None or payload.get("status") != "compiled":
        raise TscircuitBuildError("TSCIRCUIT_PROTOCOL_ERROR", "worker returned no valid compiled result", completed.returncode)

    project_name = payload.get("projectName")
    circuit_hash = payload.get("circuitJsonSha256")
    component_count = payload.get("componentCount")
    net_count = payload.get("netCount")
    if not isinstance(project_name, str) or not project_name:
        raise TscircuitBuildError("TSCIRCUIT_PROTOCOL_ERROR", "worker response has an invalid projectName")
    if not isinstance(circuit_hash, str) or not _HASH_RE.fullmatch(circuit_hash):
        raise TscircuitBuildError("TSCIRCUIT_PROTOCOL_ERROR", "worker response has an invalid Circuit JSON hash")
    if any(not isinstance(count, int) or isinstance(count, bool) or count < 0 for count in (component_count, net_count)):
        raise TscircuitBuildError("TSCIRCUIT_PROTOCOL_ERROR", "worker response has invalid graph counts")

    return TscircuitBuildResult(
        project_name=project_name,
        output_dir=_required_path(payload, "outputDir"),
        circuit_json_path=_required_path(payload, "circuitJsonPath"),
        source_graph_path=_required_path(payload, "sourceGraphPath"),
        source_manifest_path=_required_path(payload, "sourceManifestPath"),
        kicad_output_dir=_required_path(payload, "kicadOutputDir"),
        manifest_path=_required_path(payload, "manifestPath"),
        circuit_json_sha256=circuit_hash,
        component_count=component_count,
        net_count=net_count,
    )
