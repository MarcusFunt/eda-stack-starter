"""Read-only discovery of local tools used by Studio workflows."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from edastack.studio.contracts import ToolchainEntry, ToolchainResponse

_COMMAND_TIMEOUT_SECONDS = 3
_VERSION_LINE_LIMIT = 200
_IMAGE_RE = re.compile(r'export const PROJECT_SANDBOX_IMAGE = "([^"\r\n]+)";')
_PROJECT_LABEL_RE = re.compile(r'const PROJECT_SANDBOX_LABEL = "([^"\r\n]+)";')
_PROJECT_LABEL_VALUE_RE = re.compile(r'const PROJECT_SANDBOX_LABEL_VALUE = "([^"\r\n]+)";')
_LOCK_LABEL_RE = re.compile(r'const PROJECT_LOCK_LABEL = "([^"\r\n]+)";')


def _project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _probe_cli(
    name: str,
    args: list[str],
    *,
    executable_lookup: Callable[[str], str | None],
    command_runner: Callable[..., Any],
) -> tuple[ToolchainEntry, str | None]:
    configured = os.environ.get(f"EDA_STUDIO_{name.upper()}")
    executable = executable_lookup(configured or name)
    if not executable:
        return ToolchainEntry(status="unavailable", reason="Executable was not found."), None
    try:
        result = command_runner(
            [executable, *args],
            capture_output=True,
            text=True,
            timeout=_COMMAND_TIMEOUT_SECONDS,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ToolchainEntry(status="unavailable", reason="Version probe could not complete."), executable
    if result.returncode != 0:
        return ToolchainEntry(status="unavailable", reason="Executable or its required service is unavailable."), executable
    output = (result.stdout or result.stderr or "").strip()
    version = next((line.strip() for line in output.splitlines() if line.strip()), "unknown")
    return ToolchainEntry(status="available", version=version[:_VERSION_LINE_LIMIT]), executable


def _constant(pattern: re.Pattern[str], source: str) -> str | None:
    match = pattern.search(source)
    return match.group(1) if match else None


def _probe_sandbox(
    docker_executable: str | None,
    *,
    command_runner: Callable[..., Any],
) -> ToolchainEntry:
    if not docker_executable:
        return ToolchainEntry(status="unavailable", reason="Docker daemon is unavailable.")

    root = _project_root()
    worker_source = root / "packages" / "tscircuit-worker" / "src" / "build.ts"
    lock_path = root / "packages" / "tscircuit-compiler" / "package-lock.json"
    try:
        source = worker_source.read_text(encoding="utf-8")
        image = _constant(_IMAGE_RE, source)
        project_label = _constant(_PROJECT_LABEL_RE, source)
        project_label_value = _constant(_PROJECT_LABEL_VALUE_RE, source)
        lock_label = _constant(_LOCK_LABEL_RE, source)
        lock_hash = hashlib.sha256(lock_path.read_bytes()).hexdigest()
    except OSError:
        return ToolchainEntry(status="error", reason="Pinned compiler metadata is unavailable.")
    if not all((image, project_label, project_label_value, lock_label)):
        return ToolchainEntry(status="error", reason="Pinned compiler metadata could not be read.")

    try:
        inspected = command_runner(
            [docker_executable, "image", "inspect", "--format", "{{json .Config.Labels}}", image],
            capture_output=True,
            text=True,
            timeout=_COMMAND_TIMEOUT_SECONDS,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ToolchainEntry(status="unavailable", reason="Pinned sandbox image is not available locally.")
    if inspected.returncode != 0:
        return ToolchainEntry(status="unavailable", reason="Pinned sandbox image is not available locally.")
    try:
        labels = json.loads(inspected.stdout or "")
    except json.JSONDecodeError:
        return ToolchainEntry(status="error", reason="Docker returned invalid sandbox image metadata.")
    if labels.get(project_label) != project_label_value or labels.get(lock_label) != lock_hash:
        return ToolchainEntry(status="unavailable", reason="Pinned sandbox image is stale; rebuild it from the compiler lockfile.")

    try:
        image_id = command_runner(
            [docker_executable, "image", "inspect", "--format", "{{.Id}}", image],
            capture_output=True,
            text=True,
            timeout=_COMMAND_TIMEOUT_SECONDS,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ToolchainEntry(status="error", reason="Docker could not confirm the sandbox image ID.")
    value = (image_id.stdout or "").strip()
    if image_id.returncode != 0 or not re.fullmatch(r"sha256:[a-f0-9]{64}", value):
        return ToolchainEntry(status="error", reason="Docker returned an invalid sandbox image ID.")
    return ToolchainEntry(status="available", version=value)


def detect_toolchain(
    *,
    executable_lookup: Callable[[str], str | None] | None = None,
    command_runner: Callable[..., Any] | None = None,
) -> ToolchainResponse:
    """Report installed tools without running project files or installing anything."""

    lookup = executable_lookup or shutil.which
    runner = command_runner or subprocess.run
    tools: dict[str, ToolchainEntry] = {
        "python": ToolchainEntry(status="available", version=platform.python_version())
    }
    for name, arguments in (
        ("node", ["--version"]),
        ("ngspice", ["--version"]),
        ("kicad_cli", ["version"]),
        ("docker", ["version", "--format", "{{.Server.Version}}"]),
    ):
        tools[name], _ = _probe_cli(
            name,
            arguments,
            executable_lookup=lookup,
            command_runner=runner,
        )

    root = _project_root()
    worker_root = root / "packages" / "tscircuit-worker"
    node_path = lookup(os.environ.get("EDA_STUDIO_NODE") or "node")
    if (worker_root / "package.json").is_file() and (worker_root / "node_modules" / "tsx").is_dir() and node_path:
        tools["tscircuit_worker"] = ToolchainEntry(status="available", version="0.1.0")
    else:
        tools["tscircuit_worker"] = ToolchainEntry(
            status="unavailable",
            reason="Worker source, Node, or its pinned dependencies are unavailable.",
        )

    docker_path = lookup(os.environ.get("EDA_STUDIO_DOCKER") or "docker")
    tools["tscircuit_sandbox"] = _probe_sandbox(docker_path, command_runner=runner)
    return ToolchainResponse(
        checked_at_utc=datetime.now(timezone.utc),
        tools=tools,
    )
