"""Presentation-only normalization and evidence indexing for the offline dashboard.

This module never changes reports, verification decisions, or source artifacts.
A visual "measured" result intentionally does not claim a verification pass.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Callable

PREVIEW_LIMIT = 16_384


def _has_value(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _has_limit(check: dict[str, Any]) -> bool:
    return _has_value(check.get("min")) or _has_value(check.get("max"))


def _check_status(check: dict[str, Any]) -> str:
    source_status = str(check.get("status", "")).lower()
    if source_status in ("error", "infrastructure_error") or check.get("error"):
        return "error"
    if source_status in ("not_run", "skipped") or not _has_value(check.get("value")):
        return "not-run"
    if check.get("passed") is False or source_status == "fail":
        return "failed"
    if _has_limit(check):
        return "passed" if check.get("passed") is True else "not-run"
    return "measured"


def _scenario_status(scenario: dict[str, Any]) -> str:
    status = str(scenario.get("status", "")).lower()
    checks = scenario.get("checks", [])
    if status in ("error", "simulation_error", "infrastructure_error") or any(
        check["display_status"] == "error" for check in checks
    ):
        return "error"
    if status == "fail" or any(check["display_status"] == "failed" for check in checks):
        return "failed"
    if any(check["display_status"] == "not-run" for check in checks):
        return "not-run"
    if any(check["display_status"] == "passed" for check in checks):
        return "passed"
    if any(check["display_status"] == "measured" for check in checks):
        return "measured"
    return "not-run"


def _evidence(label: str, path_string: Any, *, binary: bool = False) -> dict[str, Any] | None:
    if not isinstance(path_string, str) or not path_string:
        return None
    path = Path(path_string)
    evidence: dict[str, Any] = {
        "label": label,
        "path": path_string,
        "available": False,
        "uri": "",
        "preview": "",
        "truncated": False,
    }
    try:
        if not path.is_file():
            return evidence
        evidence["available"] = True
        evidence["uri"] = path.resolve().as_uri()
        if binary:
            evidence["preview"] = "Binary artifact. Open the original file to inspect it."
        else:
            with path.open("rb") as stream:
                content = stream.read(PREVIEW_LIMIT + 1)
            evidence["truncated"] = len(content) > PREVIEW_LIMIT
            evidence["preview"] = content[:PREVIEW_LIMIT].decode("utf-8", errors="replace")
    except (OSError, ValueError):
        evidence["available"] = False
        evidence["uri"] = ""
        evidence["preview"] = "Artifact could not be read."
    return evidence


def enrich_dashboard(
    data: dict[str, Any],
    report_paths: list[Path],
    original_reports: list[dict[str, Any]],
    deck_diff_fn: Callable[[list[dict[str, Any]]], list[dict[str, str]]],
) -> dict[str, Any]:
    """Enrich the dashboard view with honest statuses and source evidence."""
    for run, report, report_path in zip(
        data["runs"], original_reports, report_paths, strict=True
    ):
        for scenario, source_scenario in zip(
            run["scenarios"], report["scenarios"], strict=True
        ):
            for check in scenario["checks"]:
                check["display_status"] = _check_status(check)
            scenario["display_status"] = _scenario_status(scenario)
            artifacts = source_scenario.get("artifacts")
            if not isinstance(artifacts, dict):
                artifacts = {}
            entries = [
                _evidence("Original verification report", str(report_path)),
                _evidence("Rendered SPICE netlist", artifacts.get("netlist")),
                _evidence("Simulator log", artifacts.get("log")),
            ]
            waveforms = artifacts.get("waveforms")
            if isinstance(waveforms, list):
                for i, wave in enumerate(waveforms):
                    if not isinstance(wave, dict):
                        continue
                    entries.append(
                        _evidence("Waveform CSV #" + str(i + 1), wave.get("csv"))
                    )
                    entries.append(
                        _evidence(
                            "Raw waveform #" + str(i + 1), wave.get("raw"), binary=True
                        )
                    )
            scenario["evidence"] = [entry for entry in entries if entry is not None]

    # Deck comparisons are only meaningful within the SAME authored project.
    project_reports: dict[str, list[dict[str, Any]]] = {}
    for report in original_reports:
        project_reports.setdefault(report["project"], []).append(report)
    data["diffs"] = [
        diff
        for group in project_reports.values()
        if len(group) > 1
        for diff in deck_diff_fn(group)
    ]
    data["max_display_points"] = 2000
    return data
