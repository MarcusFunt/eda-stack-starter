#!/usr/bin/env python3
"""Small KiCad 10 helper for the Topola routing benchmark."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import pcbnew


def load_board(path: Path):
    board = pcbnew.LoadBoard(str(path))
    if board is None:
        raise RuntimeError(f"could not load KiCad board: {path}")
    return board


def export_dsn(board_path: Path, dsn_path: Path) -> None:
    board = load_board(board_path)
    dsn_path.parent.mkdir(parents=True, exist_ok=True)
    result = pcbnew.ExportSpecctraDSN(board, str(dsn_path))
    if result is False or not dsn_path.is_file() or dsn_path.stat().st_size == 0:
        raise RuntimeError(f"KiCad failed to export DSN: {dsn_path}")


def import_ses(board_path: Path, ses_path: Path, output_path: Path) -> None:
    board = load_board(board_path)
    if not pcbnew.ImportSpecctraSES(board, str(ses_path)):
        raise RuntimeError(f"KiCad failed to import SES: {ses_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    pcbnew.SaveBoard(str(output_path), board)


def measure(board_path: Path, drc_path: Path, output_path: Path, expected_nets: list[str]) -> None:
    board = load_board(board_path)
    drc = json.loads(drc_path.read_text(encoding="utf-8"))
    tracks = list(board.GetTracks())
    vias = [item for item in tracks if isinstance(item, pcbnew.PCB_VIA)]
    segments = [
        item
        for item in tracks
        if isinstance(item, pcbnew.PCB_TRACK) and not isinstance(item, pcbnew.PCB_VIA)
    ]
    by_net: dict[str, dict[str, float | int]] = defaultdict(lambda: {"segments": 0, "length_mm": 0.0})
    for item in segments:
        net = item.GetNetname() or "<no-net>"
        by_net[net]["segments"] += 1
        by_net[net]["length_mm"] += item.GetLength() / 1_000_000

    unrouted_nets: set[str] = set()
    for group in drc.get("unconnected_items", []):
        for item in group.get("items", []):
            text = item.get("description", "")
            unrouted_nets.update(re.findall(r"\[([^\]]+)\]", text))
    expected = set(expected_nets)
    routed = expected - unrouted_nets
    groups = Counter((entry.get("severity", "unknown"), entry.get("type", "unknown")) for entry in drc.get("violations", []))

    result = {
        "board": str(board_path.name),
        "kicad_version": pcbnew.GetBuildVersion(),
        "expected_nets": sorted(expected),
        "routed_nets": sorted(routed),
        "unrouted_nets": sorted(unrouted_nets),
        "routed_net_fraction": round(len(routed) / len(expected), 6) if expected else None,
        "unconnected_groups": len(drc.get("unconnected_items", [])),
        "drc_violation_count": len(drc.get("violations", [])),
        "drc_violation_groups": [
            {"severity": severity, "type": type_name, "count": count}
            for (severity, type_name), count in sorted(groups.items())
        ],
        "schematic_parity_issue_count": len(drc.get("schematic_parity", [])),
        "ignored_checks": [entry.get("key") for entry in drc.get("ignored_checks", [])],
        "track_segments": len(segments),
        "vias": len(vias),
        "track_length_mm": round(sum(item.GetLength() for item in segments) / 1_000_000, 6),
        "tracks_by_net": {
            net: {"segments": value["segments"], "length_mm": round(value["length_mm"], 6)}
            for net, value in sorted(by_net.items())
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    export_parser = subparsers.add_parser("export-dsn")
    export_parser.add_argument("board", type=Path)
    export_parser.add_argument("dsn", type=Path)
    import_parser = subparsers.add_parser("import-ses")
    import_parser.add_argument("board", type=Path)
    import_parser.add_argument("ses", type=Path)
    import_parser.add_argument("output", type=Path)
    metrics_parser = subparsers.add_parser("measure")
    metrics_parser.add_argument("board", type=Path)
    metrics_parser.add_argument("drc", type=Path)
    metrics_parser.add_argument("output", type=Path)
    metrics_parser.add_argument("--expected-nets", default="VIN,MID,GND")
    args = parser.parse_args()

    if args.command == "export-dsn":
        export_dsn(args.board, args.dsn)
    elif args.command == "import-ses":
        import_ses(args.board, args.ses, args.output)
    else:
        measure(args.board, args.drc, args.output, [value for value in args.expected_nets.split(",") if value])


if __name__ == "__main__":
    main()
