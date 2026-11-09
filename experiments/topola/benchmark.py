"""Reproducible Specctra DSN -> Topola -> SES placement mutation benchmark.

This is fresh re-routing, NOT preservation of JITX-like topological route intent.
Only reports the geometry emitted by Topola. Use import_and_drc.py for native DRC.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLACE = re.compile(
    r"(?P<prefix>\(place\s+(?P<ref>[A-Za-z0-9_]+)\s+)"
    r"(?P<x>-?\d+(?:\.\d+)?)\s+(?P<y>-?\d+(?:\.\d+)?)"
    r"(?P<suffix>\s+(?:front|back)\s+-?\d+(?:\.\d+)?)"
)
PATH = re.compile(r"\(path\s+([\w.]+)\s+(\d+(?:\.\d+)?)\s+([0-9eE.+\-\s]+?)\)")
NET = re.compile(r"\(net\s+(?:\"([^\"]+)\"|([^\s()]+))")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def shift_placement(dsn: str, ref: str, dx_mm: float) -> str:
    """Only change a component's X placement; DSN fixture uses micrometers."""
    if "(unit um)" not in dsn:
        raise ValueError("Expected a DSN using micrometers")
    found = []

    def replace(match: re.Match) -> str:
        if match.group("ref") != ref:
            return match.group(0)
        found.append(match.group("ref"))
        x = float(match.group("x")) + 1000.0 * dx_mm
        return f'{match.group("prefix")}{x:.6f} {match.group("y")}{match.group("suffix")}'

    result = PLACE.sub(replace, dsn)
    if len(found) != 1:
        raise ValueError(f"Expected exactly one place entry for {ref}: found {len(found)}")
    return result


def session_geometry(session: str) -> dict:
    """Summarize emitted wire paths. Not an electrical connectivity/DRC proof."""
    by_layer: dict[str, float] = {}
    wire_paths, route_segments = 0, 0
    for match in PATH.finditer(session):
        layer = match.group(1)
        coords = [float(n) for n in match.group(3).split()]
        if len(coords) < 4 or len(coords) % 2:
            raise ValueError(f"Malformed route coordinates in {layer}")
        route_segments += len(coords) // 2 - 1
        wire_paths += 1
        length_um = sum(
            math.hypot(coords[i + 2] - coords[i], coords[i + 3] - coords[i + 1])
            for i in range(0, len(coords) - 2, 2)
        )
        by_layer[layer] = by_layer.get(layer, 0) + length_um / 1000.0
    names = [a or b for a, b in NET.findall(session)]
    return {
        "session_net_count": len(names),
        "session_net_names": sorted(names),
        "wire_path_count": wire_paths,
        "route_segment_count": route_segments,
        "route_length_mm": round(sum(by_layer.values()), 4),
        "route_length_by_layer_mm": {k: round(v, 4) for k, v in sorted(by_layer.items())},
        "via_token_count": len(re.findall(r"\(via\s+", session)),
    }


def run(
    topola: Path, dsn: Path, out: Path, dx_values: list[float], timeout: int,
    commands: Path | None = None,
) -> dict:
    if not topola.is_file():
        raise FileNotFoundError(f"Topola executable missing: {topola}")
    if out.exists():
        raise FileExistsError(f"Refusing to overwrite benchmark directory: {out}")
    out.mkdir(parents=True)
    raw = dsn.read_text(encoding="utf-8")
    source_nets = sorted({a or b for a, b in NET.findall(raw)})
    report = {
        "method": "fresh-reroute-per-placement; not a persistent-homotopy benchmark",
        "source": str(dsn),
        "source_sha256": sha256(dsn),
        "topola_binary_sha256": sha256(topola),
        "commands_sha256": sha256(commands) if commands else None,
        "mutation_ref": "D3",
        "source_nets": source_nets,
        "cases": [],
    }
    for i, dx in enumerate(dx_values):
        slug = f"{i:02d}_D3_x_{dx:+g}mm".replace(".", "p")
        case = out / slug
        case.mkdir()
        source = case / "design.dsn"
        session = case / "routes.ses"
        source.write_text(shift_placement(raw, "D3", dx), encoding="utf-8")
        t0 = time.perf_counter()
        try:
            command = [str(topola), str(source), "--output", str(session)]
            if commands is not None:
                command.extend(["--commands", str(commands)])
            proc = subprocess.run(
                command, capture_output=True, text=True, timeout=timeout, check=False,
            )
            elapsed = time.perf_counter() - t0
            result = {
                "id": slug, "dx_mm": dx, "seconds": round(elapsed, 4),
                "exit_code": proc.returncode, "dsn_sha256": sha256(source),
                "topola_stdout": proc.stdout[-1200:],
                "topola_stderr": proc.stderr[-1200:],
            }
            if proc.returncode == 0 and session.is_file():
                result["ses_sha256"] = sha256(session)
                result.update(session_geometry(session.read_text(encoding="utf-8")))
                result["session_contains_all_source_nets"] = (
                    set(source_nets) <= set(result["session_net_names"])
                )
                result["status"] = "ses_generated" if result["session_contains_all_source_nets"] else "nets_missing"
            else:
                result["status"] = "backend_failed"
        except subprocess.TimeoutExpired:
            result = {"id": slug, "dx_mm": dx, "seconds": timeout, "status": "timeout"}
        report["cases"].append(result)
        print(json.dumps({k: result.get(k) for k in (
            "id", "status", "seconds", "route_length_mm", "wire_path_count", "via_token_count"
        )}), flush=True)
    (out / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--topola", type=Path, required=True)
    parser.add_argument("--dsn", type=Path, default=HERE / "fixtures" / "bridge.dsn")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--dx-mm", nargs="+", type=float, default=[0.0, -1.0, -2.0])
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--commands", type=Path, help="Optional Topola command-history configuration")
    args = parser.parse_args()
    report = run(args.topola, args.dsn, args.out, args.dx_mm, args.timeout, args.commands)
    if any(case["status"] != "ses_generated" for case in report["cases"]):
        raise SystemExit("One or more routing cases failed or omitted nets")


if __name__ == "__main__":
    main()
