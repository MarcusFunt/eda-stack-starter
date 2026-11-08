"""Command-line entrypoint."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from . import __version__
from .core import (
    DEFAULT_DOCKER_IMAGE,
    EDAError,
    executable_path,
    ngspice_version,
    run_project,
)
from .dashboard import build_dashboard


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="edastack",
        description="Local ngspice verification harness for AI electronics design",
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)
    doctor = sub.add_parser("doctor", help="Check the local toolchain")
    doctor.add_argument("--ngspice", default=os.environ.get("NGSPICE_EXE", "ngspice"))
    doctor.add_argument("--docker", default=os.environ.get("DOCKER_EXE", "docker"))
    dashboard = sub.add_parser(
        "dashboard", help="Build an offline dashboard from verification reports"
    )
    dashboard.add_argument(
        "reports", type=Path, nargs="+", help="Input report.json files"
    )
    dashboard.add_argument(
        "--bom",
        type=Path,
        action="append",
        default=[],
        help="Optional BOM JSON (repeatable)",
    )
    dashboard.add_argument(
        "--out", type=Path, default=Path("build/dashboard/index.html")
    )
    sim = sub.add_parser(
        "verify", help="Simulate all specification corners and check limits"
    )
    sim.add_argument("spec", type=Path, help="Path to project spec.json")
    sim.add_argument("--out", type=Path, default=Path("build/verify"))
    sim.add_argument("--ngspice", default=os.environ.get("NGSPICE_EXE", "ngspice"))
    sim.add_argument(
        "--isolation",
        choices=("host", "docker"),
        default=os.environ.get("EDASTACK_ISOLATION", "host"),
        help="Run ngspice directly or inside a resource-limited Docker container",
    )
    sim.add_argument(
        "--docker-image",
        default=os.environ.get("EDASTACK_DOCKER_IMAGE", DEFAULT_DOCKER_IMAGE),
        help="Digest-pinned image containing ngspice (Docker isolation only)",
    )
    sim.add_argument("--docker", default=os.environ.get("DOCKER_EXE", "docker"))
    sim.add_argument(
        "--timeout", type=int, default=90, help="Maximum seconds per scenario (1-600)"
    )
    sim.add_argument("--memory-limit-mb", type=int, default=1024)
    sim.add_argument("--cpu-limit", type=float, default=1.0)
    sim.add_argument("--pids-limit", type=int, default=64)
    sim.add_argument("--storage-limit-mb", type=int, default=512)
    sim.add_argument("--input-limit-mb", type=int, default=128)
    args = parser.parse_args(argv)
    if args.command == "doctor":
        binary = executable_path(args.ngspice)
        print(
            json.dumps(
                {
                    "ngspice_available": bool(binary),
                    "ngspice_path": binary,
                    "ngspice_version": ngspice_version(binary) if binary else None,
                    "docker_executable_available": bool(shutil.which(args.docker)),
                    "docker_image": DEFAULT_DOCKER_IMAGE,
                    "qucs_s_available": bool(shutil.which("qucs-s")),
                    "python": sys.version.split()[0],
                },
                indent=2,
            )
        )
        return 0 if binary else 2
    if args.command == "dashboard":
        try:
            output = build_dashboard(args.reports, args.out, args.bom)
            print(
                json.dumps(
                    {
                        "dashboard": str(output.resolve()),
                        "reports": len(args.reports),
                        "bom_files": len(args.bom),
                    },
                    indent=2,
                )
            )
            return 0
        except (EDAError, ValueError, OSError, json.JSONDecodeError) as exc:
            print(f"edastack: {exc}", file=sys.stderr)
            return 2
    try:
        report = run_project(
            args.spec,
            args.out,
            binary=args.ngspice,
            timeout=args.timeout,
            isolation=args.isolation,
            docker_image=args.docker_image,
            docker_binary=args.docker,
            memory_limit_mb=args.memory_limit_mb,
            cpu_limit=args.cpu_limit,
            pids_limit=args.pids_limit,
            storage_limit_mb=args.storage_limit_mb,
            input_limit_mb=args.input_limit_mb,
        )
        print(
            json.dumps(
                {
                    "project": report["project"],
                    "passed": report["passed"],
                    "execution": report["execution"],
                    "scenarios": [
                        {
                            "name": x["scenario"],
                            "status": x["status"],
                            "violations": [
                                c["id"] for c in x["checks"] if not c["passed"]
                            ],
                            "errors": x["errors"],
                        }
                        for x in report["scenarios"]
                    ],
                    "report": str(args.out.resolve() / "report.json"),
                },
                indent=2,
            )
        )
        return 0 if report["passed"] else 1
    except (EDAError, ValueError, OSError, json.JSONDecodeError) as exc:
        print(f"edastack: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
