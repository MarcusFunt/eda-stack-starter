"""Import Topola SES into matching KiCad boards, with synchronized placement edits.

Run with KiCad's embedded Python interpreter (pcbnew must be importable).
Uses native KiCad 10 CLI DRC. Findings are never silently waived.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import pcbnew


def summarize_drc(data: dict) -> dict:
    summary = {}
    for key in ("violations", "unconnected_items", "schematic_parity"):
        items = data.get(key, [])
        if isinstance(items, list):
            summary[key] = len(items)
            summary[key + "_types"] = sorted({
                str(item.get("type", "unknown")) for item in items if isinstance(item, dict)
            })
        else:
            summary[key] = None
    return summary


def import_board(source: Path, ses: Path, output: Path, dx_mm: float) -> dict:
    if not source.is_file() or not ses.is_file():
        raise FileNotFoundError(f"Missing board or SES: {source}, {ses}")
    board = pcbnew.LoadBoard(str(source))
    footprints = [f for f in board.GetFootprints() if f.GetReference() == "D3"]
    if len(footprints) != 1:
        raise ValueError(f"Expected one D3 footprint, got {len(footprints)}")
    footprint = footprints[0]
    old = footprint.GetPosition()
    delta = pcbnew.FromMM(dx_mm)
    footprint.SetPosition(pcbnew.VECTOR2I(old.x + delta, old.y))
    if not pcbnew.ImportSpecctraSES(board, str(ses)):
        raise RuntimeError(f"KiCad rejected Specctra session: {ses}")
    pcbnew.SaveBoard(str(output), board)
    return {
        "d3_x_mm": pcbnew.ToMM(footprint.GetPosition().x),
        "d3_y_mm": pcbnew.ToMM(footprint.GetPosition().y),
        "tracks": len(list(board.GetTracks())),
        "vias": sum(isinstance(t, pcbnew.PCB_VIA) for t in board.GetTracks()),
    }


def run(out: Path, source: Path, kicad_cli: Path) -> dict:
    if not kicad_cli.is_file():
        raise FileNotFoundError(kicad_cli)
    report_file = out / "report.json"
    report = json.loads(report_file.read_text(encoding="utf-8"))
    for case in report["cases"]:
        if case["status"] != "ses_generated":
            case["native"] = {"status": "skipped_route_unavailable"}
            continue
        case_dir = out / case["id"]
        board_file = case_dir / "routed.kicad_pcb"
        try:
            board_info = import_board(source, case_dir / "routes.ses", board_file, float(case["dx_mm"]))
            drc_json = case_dir / "kicad-drc.json"
            proc = subprocess.run([
                str(kicad_cli), "pcb", "drc", "--format", "json",
                "--severity-all", "--exit-code-violations",
                "--output", str(drc_json), str(board_file),
            ], capture_output=True, text=True, timeout=120, check=False)
            native = {
                "status": "drc_reported" if drc_json.exists() else "drc_execution_failed",
                "kicad_drc_exit_code": proc.returncode,
                "kicad_stdout": proc.stdout[-1200:],
                "kicad_stderr": proc.stderr[-1200:],
                **board_info,
            }
            if drc_json.exists():
                native.update(summarize_drc(json.loads(drc_json.read_text(encoding="utf-8"))))
            native["release_ready"] = (
                native["status"] == "drc_reported"
                and native["kicad_drc_exit_code"] == 0
                and native.get("violations") == 0
                and native.get("unconnected_items") == 0
            )
            case["native"] = native
        except Exception as exc:
            case["native"] = {"status": "failed", "error": repr(exc)}
        print(json.dumps({
            "id": case["id"], "native": {
                k: case["native"].get(k) for k in ("status", "violations", "unconnected_items", "tracks", "vias", "error")
            }
        }), flush=True)
    (out / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--source-board", type=Path, default=Path(__file__).parent / "fixtures" / "bridge.kicad_pcb")
    parser.add_argument("--kicad-cli", type=Path, required=True)
    args = parser.parse_args()
    report = run(args.out, args.source_board, args.kicad_cli)
    if any(case.get("native", {}).get("status") != "drc_reported" for case in report["cases"]):
        raise SystemExit("At least one case did not produce native DRC evidence")


if __name__ == "__main__":
    main()
