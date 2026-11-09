"""Build a self-contained, offline dashboard from EDA Stack artifacts."""

from __future__ import annotations

import csv
import difflib
import json
import math
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .core import EDAError

MAX_WAVEFORM_POINTS = 2000


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise EDAError(f"Cannot read dashboard input {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise EDAError(f"Dashboard input must be a JSON object: {path}")
    return value


def _required_report(path: Path) -> dict[str, Any]:
    report = _read_json(path)
    if not isinstance(report.get("project"), str) or not isinstance(
        report.get("scenarios"), list
    ):
        raise EDAError(f"Report must contain a project and scenarios: {path}")
    for scenario in report["scenarios"]:
        if not isinstance(scenario, dict):
            raise EDAError(f"Report contains an invalid scenario: {path}")
        checks = scenario.get("checks", [])
        if not isinstance(checks, list) or any(
            not isinstance(check, dict) for check in checks
        ):
            raise EDAError(f"Report contains an invalid check: {path}")
    return report


def _waveform_rows(
    csv_path: Path, signals: list[str]
) -> Iterator[tuple[float, list[float]]]:
    try:
        with csv_path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            if not reader.fieldnames or "time_s" not in reader.fieldnames:
                raise EDAError(f"Waveform CSV has no time_s column: {csv_path}")
            missing = [signal for signal in signals if signal not in reader.fieldnames]
            if missing:
                raise EDAError(
                    f"Waveform CSV is missing signal columns {missing}: {csv_path}"
                )
            previous_time = -math.inf
            for row in reader:
                try:
                    time_value = float(row["time_s"])
                    if not math.isfinite(time_value) or time_value <= previous_time:
                        raise ValueError("time must be finite and strictly increasing")
                    values = [float(row[signal]) for signal in signals]
                    if any(not math.isfinite(value) for value in values):
                        raise ValueError("signal values must be finite")
                except (KeyError, TypeError, ValueError) as exc:
                    raise EDAError(
                        f"Waveform CSV contains an invalid sample: {csv_path}"
                    ) from exc
                previous_time = time_value
                yield time_value, values
    except (OSError, UnicodeError, csv.Error) as exc:
        raise EDAError(f"Cannot read waveform CSV {csv_path}: {exc}") from exc


def _read_waveform(
    csv_path: Path,
    signals: list[str],
    *,
    label: str,
    run_id: str,
    scenario: str,
    analysis: str,
) -> list[dict[str, Any]]:
    """Downsample per signal using per-bucket extrema, never averaging peaks away."""
    row_count = sum(1 for _ in _waveform_rows(csv_path, signals))
    if not row_count:
        raise EDAError(f"Waveform CSV contains no samples: {csv_path}")
    buckets = max(1, (MAX_WAVEFORM_POINTS - 2) // 2)
    small = row_count <= MAX_WAVEFORM_POINTS
    points: dict[str, list[tuple[int, float, float]]] = {signal: [] for signal in signals}
    extrema: dict[str, list[list[tuple[int, float, float] | None]]] = {
        signal: [[None, None] for _ in range(buckets)] for signal in signals
    } if not small else {}
    second_pass_count = 0
    for index, (time_value, values) in enumerate(_waveform_rows(csv_path, signals)):
        second_pass_count += 1
        for signal, value in zip(signals, values, strict=True):
            point = (index, time_value, value)
            if small or index == 0 or index == row_count - 1:
                points[signal].append(point)
                continue
            bucket = min(buckets - 1, (index - 1) * buckets // (row_count - 2))
            minimum, maximum = extrema[signal][bucket]
            if minimum is None or value < minimum[2]:
                extrema[signal][bucket][0] = point
            if maximum is None or value > maximum[2]:
                extrema[signal][bucket][1] = point
    if second_pass_count != row_count:
        raise EDAError(f"Waveform CSV changed while being read: {csv_path}")
    result = []
    for signal in signals:
        samples = points[signal]
        if not small:
            for minimum, maximum in extrema[signal]:
                if minimum is not None:
                    samples.append(minimum)
                if maximum is not None:
                    samples.append(maximum)
            samples.sort(key=lambda p: p[0])
            samples = list({p[0]: p for p in samples}.values())
        result.append(
            {
                "label": f"{label} · {scenario} · {analysis} · {signal}",
                "run_id": run_id,
                "scenario": scenario,
                "analysis": analysis,
                "signal": signal,
                "samples": row_count,
                "display_samples": len(samples),
                "x": [p[1] for p in samples],
                "y": [p[2] for p in samples],
            }
        )
    return result


def _scenario_deck(scenario: dict[str, Any]) -> tuple[str | None, str | None]:
    artifacts = scenario.get("artifacts", {})
    netlist = artifacts.get("netlist") if isinstance(artifacts, dict) else None
    if not isinstance(netlist, str):
        return None, None
    path = Path(netlist)
    try:
        return netlist, path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return netlist, None


def _deck_diffs(reports: list[dict[str, Any]]) -> list[dict[str, str]]:
    if len(reports) < 2:
        return []
    baseline = reports[0]
    baseline_scenarios = baseline.get("scenarios", [])
    if not baseline_scenarios:
        return []
    base_scenario = baseline_scenarios[0]
    base_path, base_text = _scenario_deck(base_scenario)
    diffs = []
    for candidate in reports[1:]:
        scenarios = candidate.get("scenarios", [])
        if not scenarios:
            continue
        candidate_scenario = next(
            (
                item
                for item in scenarios
                if item.get("scenario") == base_scenario.get("scenario")
            ),
            scenarios[0],
        )
        candidate_path, candidate_text = _scenario_deck(candidate_scenario)
        if base_text is None or candidate_text is None:
            diff = "Archived scenario input is unavailable for this run."
        else:
            diff_lines = difflib.unified_diff(
                base_text.splitlines(),
                candidate_text.splitlines(),
                fromfile=f"baseline/{base_scenario.get('scenario', 'scenario')}",
                tofile=f"candidate/{candidate_scenario.get('scenario', 'scenario')}",
                lineterm="",
            )
            diff = "\n".join(diff_lines) or "No scenario deck changes."
        diffs.append(
            {
                "label": (
                    f"{baseline.get('project')} {baseline.get('run_id', 'baseline')} "
                    f"({base_scenario.get('scenario')}) → "
                    f"{candidate.get('run_id', 'candidate')} "
                    f"({candidate_scenario.get('scenario')})"
                ),
                "baseline_path": base_path or "",
                "candidate_path": candidate_path or "",
                "text": diff,
            }
        )
    return diffs


def _dashboard_data(report_paths: list[Path], bom_paths: list[Path]) -> dict[str, Any]:
    reports = [_required_report(path) for path in report_paths]
    input_paths = {str(path.resolve()) for path in [*report_paths, *bom_paths]}
    runs = []
    waveforms = []
    for report, report_path in zip(reports, report_paths, strict=True):
        run_id = str(report.get("run_id") or report_path.parent.name)
        run = {
            "project": report["project"],
            "run_id": run_id,
            "completed": report.get("run_completed_at_utc", ""),
            "simulator": report.get("simulator_version", ""),
            "passed": report.get("passed") is True,
            "scenarios": [],
        }
        for scenario in report["scenarios"]:
            artifacts = scenario.get("artifacts", {})
            log_path = artifacts.get("log") if isinstance(artifacts, dict) else None
            if isinstance(log_path, str):
                input_paths.add(str(Path(log_path).resolve()))
            run["scenarios"].append(
                {
                    "name": scenario.get("scenario", "unknown"),
                    "category": scenario.get("category", ""),
                    "parameters": scenario.get("parameters", {}),
                    "status": scenario.get("status", "unknown"),
                    "passed": scenario.get("passed") is True,
                    "checks": [dict(check) for check in scenario.get("checks", [])],
                }
            )
            waveform_specs = (
                artifacts.get("waveforms", []) if isinstance(artifacts, dict) else []
            )
            if not isinstance(waveform_specs, list):
                raise EDAError(
                    f"Report contains invalid waveform metadata: {report_path}"
                )
            netlist = artifacts.get("netlist") if isinstance(artifacts, dict) else None
            if isinstance(netlist, str):
                input_paths.add(str(Path(netlist).resolve()))
            for waveform in waveform_specs:
                if not isinstance(waveform, dict):
                    raise EDAError(
                        f"Report contains invalid waveform metadata: {report_path}"
                    )
                csv_path = waveform.get("csv")
                signals = waveform.get("signals")
                if (
                    not isinstance(csv_path, str)
                    or not isinstance(signals, list)
                    or not signals
                    or not all(isinstance(signal, str) and signal for signal in signals)
                ):
                    raise EDAError(
                        f"Report contains incomplete waveform metadata: {report_path}"
                    )
                input_paths.add(str(Path(csv_path).resolve()))
                raw_path = waveform.get("raw")
                if isinstance(raw_path, str):
                    input_paths.add(str(Path(raw_path).resolve()))
                waveforms.extend(
                    _read_waveform(
                        Path(csv_path),
                        signals,
                        label=f"{report['project']} · {run_id}",
                        run_id=run_id,
                        scenario=str(scenario.get("scenario", "unknown")),
                        analysis=str(waveform.get("analysis", "")),
                    )
                )
        runs.append(run)

    boms = []
    for bom_path in bom_paths:
        bom = _read_json(bom_path)
        items = bom.get("items")
        if not isinstance(items, list) or any(
            not isinstance(item, dict) for item in items
        ):
            raise EDAError(f"BOM must contain an items array: {bom_path}")
        if any(not isinstance(item.get("selected_part", {}), dict) for item in items):
            raise EDAError(f"BOM contains an invalid selected part: {bom_path}")
        boms.append(
            {
                "name": bom_path.name,
                "snapshot": bom.get("snapshot_time_utc", ""),
                "items": [
                    {
                        "reference": item.get("reference", ""),
                        "quantity": item.get("quantity", ""),
                        "part": item.get("selected_part", {}),
                    }
                    for item in items
                ],
            }
        )
    return {
        "runs": runs,
        "waveforms": waveforms,
        "diffs": _deck_diffs(reports),
        "boms": boms,
        "_input_paths": sorted(input_paths),
    }


def _script_json(value: Any) -> str:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


DASHBOARD_TEMPLATE_PATH = Path(__file__).with_name("dashboard_ui.html")

def build_dashboard(
    report_paths: list[Path], output_path: Path, bom_paths: list[Path] | None = None
) -> Path:
    if not report_paths:
        raise EDAError("Provide at least one report.json file")
    from .dashboard_view import enrich_dashboard

    data = _dashboard_data(report_paths, bom_paths or [])
    reports = [_required_report(path) for path in report_paths]
    data = enrich_dashboard(data, report_paths, reports, _deck_diffs)
    output_key = os.path.normcase(str(output_path.resolve()))
    input_keys = {os.path.normcase(path) for path in data.pop("_input_paths")}
    if output_key in input_keys:
        raise EDAError("Dashboard cannot overwrite an input artifact")
    page = DASHBOARD_TEMPLATE_PATH.read_text(encoding="utf-8").replace("__DATA__", _script_json(data))
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(page, encoding="utf-8")
    except OSError as exc:
        raise EDAError(f"Cannot write dashboard {output_path}: {exc}") from exc
    return output_path
