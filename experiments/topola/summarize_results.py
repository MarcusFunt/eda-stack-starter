"""Write a portable evidence summary from two measured, native-DRC benchmark runs."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def counts(path: Path) -> dict[str, int]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    grouped: dict[str, int] = {}
    for item in raw.get("violations", []):
        label = item.get("type", "unknown")
        grouped[label] = grouped.get(label, 0) + 1
    return dict(sorted(grouped.items()))


def collect(report_path: Path) -> dict:
    raw = json.loads(report_path.read_text(encoding="utf-8"))
    rows = []
    for case in raw["cases"]:
        native = case.get("native", {})
        if native.get("status") != "drc_reported":
            raise RuntimeError(f"Missing native DRC: {case['id']}")
        if case.get("status") != "ses_generated" or not case.get("session_contains_all_source_nets"):
            raise RuntimeError(f"Unsuccessful SES case: {case['id']}")
        case_dir = report_path.parent / case["id"]
        issue_counts = counts(case_dir / "kicad-drc.json")
        rows.append({
            "id": case["id"],
            "dx_mm": case["dx_mm"],
            "topola_seconds": case["seconds"],
            "ses_wire_geometry_mm": case["route_length_mm"],
            "ses_wire_path_count": case["wire_path_count"],
            "ses_net_count": case["session_net_count"],
            "native_track_count": native["tracks"],
            "native_via_count": native["vias"],
            "native_unconnected_count": native["unconnected_items"],
            "native_drc_violations": native["violations"],
            "native_drc_exit_code": native["kicad_drc_exit_code"],
            "native_release_ready": native["release_ready"],
            "native_violation_types": issue_counts,
        })
    return {
        "source_sha256": raw["source_sha256"],
        "topola_binary_sha256": raw["topola_binary_sha256"],
        "mutation_ref": raw["mutation_ref"],
        "method": raw["method"],
        "cases": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--default", type=Path, required=True)
    parser.add_argument("--width200", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    baseline = collect(args.default)
    revised = collect(args.width200)
    if baseline["source_sha256"] != revised["source_sha256"]:
        raise RuntimeError("Input fixtures differ between runs")
    if [(c["id"], c["dx_mm"]) for c in baseline["cases"]] != [
        (c["id"], c["dx_mm"]) for c in revised["cases"]
    ]:
        raise RuntimeError("Placement mutations do not match")

    source_board = args.default.parent / "source-board-drc.json"
    source_raw = json.loads(source_board.read_text(encoding="utf-8"))
    result = {
        "experiment": "topola-dsn-ses-bridge-placement-mutations",
        "fixture_origin": "mikwielgus/topola@666e06cfd7ba1f1e5daf700288acb9e0a4f84ceb",
        "fixture": "experiments/topola/fixtures/bridge.dsn",
        "kicad": "10.0.8",
        "source_board_drc_findings": len(source_raw.get("violations", [])),
        "source_board_unconnected_count": len(source_raw.get("unconnected_items", [])),
        "source_board_violation_types": counts(source_board),
        "width100_default": baseline,
        "width200_single_source_line_patch": revised,
        "limitations": [
            "All placement variants are freshly routed, not topologically reused",
            "Session wire geometry includes original or auxiliary paths; it is not verified incremental trace length",
            "Zero unconnected items is not zero DRC violations",
            "0.2 mm build is locally patched and not an unmodified Topola release",
            "No electrical or manufacturing release claim",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Evidence written: {args.output}")


if __name__ == "__main__":
    main()
