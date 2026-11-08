"""Minimal stdio MCP server (zero runtime dependencies).

Read-only against source designs: agents can verify existing specs, but cannot
edit schematics or launch arbitrary shell commands through these tools.
Run with: edastack-mcp
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from . import __version__
from .core import DEFAULT_DOCKER_IMAGE, EDAError, executable_path, run_project

TOOLS = [
    {
        "name": "verify_spice_spec",
        "description": "Run ngspice on a project spec and its 1-32 operating corners; optionally isolate each case in a digest-pinned, resource-limited Docker container.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "spec": {
                    "type": "string",
                    "description": "Relative path to spec.json beneath EDA_STACK_ROOT",
                },
                "isolation": {"type": "string", "enum": ["host", "docker"]},
                "docker_image": {"type": "string", "default": DEFAULT_DOCKER_IMAGE},
                "timeout": {"type": "integer", "minimum": 1, "maximum": 600},
                "memory_limit_mb": {"type": "integer", "minimum": 128, "maximum": 8192},
                "cpu_limit": {"type": "number", "minimum": 0.1, "maximum": 32},
                "pids_limit": {"type": "integer", "minimum": 16, "maximum": 4096},
                "storage_limit_mb": {"type": "integer", "minimum": 16, "maximum": 4096},
                "input_limit_mb": {"type": "integer", "minimum": 4, "maximum": 1024},
            },
            "required": ["spec"],
            "additionalProperties": False,
        },
    },
    {
        "name": "eda_toolchain_status",
        "description": "Check whether ngspice is available to the agent.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
]


def workspace_path(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise EDAError("spec must be a relative path under EDA_STACK_ROOT")
    root = root.resolve()
    try:
        resolved = (root / relative).resolve(strict=False)
    except (OSError, RuntimeError, ValueError) as exc:
        raise EDAError("spec path is invalid") from exc
    if not resolved.is_relative_to(root):
        raise EDAError("Path escapes EDA_STACK_ROOT")
    if not resolved.exists():
        raise EDAError("spec path does not exist")
    if not resolved.is_file() or resolved.suffix.lower() != ".json":
        raise EDAError("spec must resolve to a JSON file")
    return resolved


def respond(request: dict[str, Any], root: Path, binary: str) -> dict[str, Any] | None:
    method, rid = request.get("method"), request.get("id")
    if rid is None:
        return None  # notifications, including notifications/initialized
    if method == "initialize":
        params = request.get("params") or {}
        return {
            "jsonrpc": "2.0",
            "id": rid,
            "result": {
                "protocolVersion": params.get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "edastack-spice", "version": __version__},
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": rid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}}
    if method != "tools/call":
        return {
            "jsonrpc": "2.0",
            "id": rid,
            "error": {"code": -32601, "message": f"Unknown method: {method}"},
        }
    params = request.get("params") or {}
    tool, arguments = params.get("name"), params.get("arguments") or {}
    try:
        if tool == "eda_toolchain_status":
            value: Any = {
                "ngspice_available": bool(executable_path(binary)),
                "ngspice_requested": binary,
            }
        elif tool == "verify_spice_spec":
            spec = workspace_path(root, arguments.get("spec"))
            out = root / "build" / "agent" / spec.relative_to(root).with_suffix("")
            report = run_project(
                spec,
                out,
                binary=binary,
                timeout=arguments.get("timeout", 90),
                isolation=arguments.get("isolation", "host"),
                docker_image=arguments.get("docker_image", DEFAULT_DOCKER_IMAGE),
                memory_limit_mb=arguments.get("memory_limit_mb", 1024),
                cpu_limit=arguments.get("cpu_limit", 1.0),
                pids_limit=arguments.get("pids_limit", 64),
                storage_limit_mb=arguments.get("storage_limit_mb", 512),
                input_limit_mb=arguments.get("input_limit_mb", 128),
            )
            value = {
                "passed": report["passed"],
                "report": str(out / "report.json"),
                "execution": report["execution"],
                "scenarios": [
                    {
                        "scenario": r["scenario"],
                        "passed": r["passed"],
                        "checks": r["checks"],
                        "errors": r["errors"],
                    }
                    for r in report["scenarios"]
                ],
            }
        else:
            raise EDAError(f"Unknown tool {tool!r}")
        return {
            "jsonrpc": "2.0",
            "id": rid,
            "result": {
                "content": [
                    {"type": "text", "text": json.dumps(value, allow_nan=False)}
                ],
                "isError": False,
            },
        }
    except (EDAError, OSError, ValueError, json.JSONDecodeError) as exc:
        return {
            "jsonrpc": "2.0",
            "id": rid,
            "result": {
                "content": [{"type": "text", "text": str(exc)}],
                "isError": True,
            },
        }


def main() -> None:
    root = Path(os.environ.get("EDA_STACK_ROOT", ".")).expanduser().resolve()
    binary = os.environ.get("NGSPICE_EXE", "ngspice")
    for line in sys.stdin:
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                continue
            result = respond(req, root, binary)
        except Exception as exc:
            print(f"edastack MCP error: {exc}", file=sys.stderr)
            continue
        if result is not None:
            sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
