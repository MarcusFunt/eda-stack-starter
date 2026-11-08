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


def _sample_indices(count: int) -> list[int]:
    if count <= MAX_WAVEFORM_POINTS:
        return list(range(count))
    return sorted(
        {
            round(index * (count - 1) / (MAX_WAVEFORM_POINTS - 1))
            for index in range(MAX_WAVEFORM_POINTS)
        }
    )


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
    row_count = sum(1 for _ in _waveform_rows(csv_path, signals))
    if not row_count:
        raise EDAError(f"Waveform CSV contains no samples: {csv_path}")
    selected_indexes = set(_sample_indices(row_count))
    times: list[float] = []
    values: dict[str, list[float]] = {signal: [] for signal in signals}
    second_pass_count = 0
    for index, (time_value, row_values) in enumerate(_waveform_rows(csv_path, signals)):
        second_pass_count += 1
        if index not in selected_indexes:
            continue
        times.append(time_value)
        for signal, value in zip(signals, row_values, strict=True):
            values[signal].append(value)
    if second_pass_count != row_count:
        raise EDAError(f"Waveform CSV changed while being read: {csv_path}")

    result = []
    for signal in signals:
        result.append(
            {
                "label": f"{label} · {scenario} · {analysis} · {signal}",
                "run_id": run_id,
                "scenario": scenario,
                "analysis": analysis,
                "signal": signal,
                "samples": row_count,
                "display_samples": len(times),
                "x": times,
                "y": values[signal],
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
                    "checks": [
                        {**check, "passed": check.get("passed") is True}
                        for check in scenario.get("checks", [])
                    ],
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


HTML_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EDA Stack verification dashboard</title>
<style>
:root { color-scheme: dark; font: 15px/1.5 "Segoe UI", system-ui, sans-serif; background: #10161d; color: #e4edf5; }
body { max-width: 1440px; margin: 0 auto; padding: 28px; }
h1 { margin: 0; font-size: 2rem; } h2 { margin: 0 0 14px; font-size: 1.25rem; }
p { color: #aebdca; } section { margin: 24px 0; padding: 20px; border: 1px solid #2b3947; border-radius: 12px; background: #17212b; }
.cards { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 18px; }
.card { min-width: 150px; padding: 14px 16px; border: 1px solid #304252; border-radius: 10px; background: #1b2935; }
.card strong { display: block; font-size: 1.5rem; }
.pass { color: #8fe0ae; } .fail { color: #ff9b91; } .muted { color: #aebdca; }
.table-wrap { overflow-x: auto; } table { width: 100%; border-collapse: collapse; min-width: 720px; }
th, td { padding: 9px 10px; border-bottom: 1px solid #304252; text-align: left; vertical-align: top; }
th { color: #aebdca; font-weight: 600; } code, pre { font-family: Consolas, "SFMono-Regular", monospace; }
code { overflow-wrap: anywhere; } pre { max-height: 420px; overflow: auto; padding: 14px; background: #0e151c; border-radius: 8px; white-space: pre-wrap; }
canvas { display: block; width: 100%; height: 390px; background: #111a23; border: 1px solid #304252; border-radius: 8px; }
label { display: inline-flex; gap: 8px; align-items: center; margin: 0 0 12px; } select { padding: 7px 10px; color: inherit; background: #1b2935; border: 1px solid #526779; border-radius: 6px; }
.legend { display: flex; flex-wrap: wrap; gap: 10px 18px; margin-top: 12px; color: #c7d4df; font-size: 0.9rem; }
.legend span { display: inline-flex; align-items: center; gap: 7px; } .swatch { width: 12px; height: 3px; display: inline-block; }
.bom { margin: 16px 0 0; } a { color: #8dc8ff; } .notice { padding: 12px; border-left: 3px solid #e4b85c; background: #29271d; color: #f2dfa9; }
@media (max-width: 700px) { body { padding: 14px; } section { padding: 14px; } }
</style>
</head>
<body>
<header>
<h1>EDA Stack verification dashboard</h1>
<p>Offline snapshot built from local reports and optional BOM files. Supplier values are captured snapshots, not live availability or purchase quotes.</p>
<div class="cards" id="summary"></div>
</header>
<section><h2>Experiment matrix</h2><div class="table-wrap"><table><thead><tr><th>Project / run</th><th>Scenario</th><th>Category</th><th>Parameters</th><th>Checks</th><th>Result</th></tr></thead><tbody id="matrix"></tbody></table></div></section>
<section><h2>Measurement limits</h2><div class="table-wrap"><table><thead><tr><th>Run / scenario</th><th>Measurement</th><th>Value</th><th>Minimum</th><th>Maximum</th><th>Result</th></tr></thead><tbody id="checks"></tbody></table></div></section>
<section><h2>Waveform overlays</h2><label for="signal">Signal <select id="signal"></select></label><canvas id="chart" aria-label="Waveform overlay chart"></canvas><div id="legend" class="legend"></div><p id="waveform-note" class="muted"></p></section>
<section><h2>Deck differences</h2><div id="diffs"></div><p class="muted">These diffs compare archived simulator input decks. They do not prove physical schematic, footprint, or PCB equivalence.</p></section>
<section><h2>BOM status</h2><div id="boms"></div></section>
<script>
const DATA = __DATA__;
const byId = (id) => document.getElementById(id);
const addCell = (row, value, className = "") => { const cell = document.createElement("td"); cell.textContent = value ?? ""; if (className) cell.className = className; row.appendChild(cell); };
const addHeaderCell = (row, value) => { const cell = document.createElement("th"); cell.textContent = value; row.appendChild(cell); };
const fmt = (value) => value === null || value === undefined ? "—" : String(value);

function renderTables() {
  const scenarios = DATA.runs.flatMap(run => run.scenarios.map(s => ({run, s})));
  const checks = scenarios.flatMap(({run, s}) => s.checks.map(check => ({run, s, check})));
  const passedCases = scenarios.filter(item => item.s.passed).length;
  const failedCases = scenarios.length - passedCases;
  const passedChecks = checks.filter(item => item.check.passed).length;
  const cards = [
    ["Runs", DATA.runs.length], ["Scenarios passed", passedCases],
    ["Scenarios failed", failedCases], ["Checks", `${passedChecks} / ${checks.length}`]
  ];
  const summary = byId("summary");
  for (const [label, value] of cards) { const card = document.createElement("div"); card.className = "card"; const strong = document.createElement("strong"); strong.textContent = value; const caption = document.createElement("span"); caption.textContent = label; card.append(strong, caption); summary.appendChild(card); }
  const matrix = byId("matrix");
  for (const {run, s} of scenarios) {
    const row = document.createElement("tr");
    addCell(row, `${run.project} · ${run.run_id}`); addCell(row, s.name); addCell(row, s.category);
    addCell(row, Object.entries(s.parameters || {}).map(([key, value]) => `${key}=${value}`).join(", "));
    addCell(row, s.checks.length); addCell(row, s.passed ? "PASS" : "FAIL", s.passed ? "pass" : "fail"); matrix.appendChild(row);
  }
  const checkTable = byId("checks");
  for (const {run, s, check} of checks) {
    const row = document.createElement("tr"); addCell(row, `${run.run_id} · ${s.name}`); addCell(row, check.id);
    addCell(row, `${fmt(check.value)} ${check.unit || ""}`.trim()); addCell(row, fmt(check.min)); addCell(row, fmt(check.max));
    addCell(row, check.passed ? "PASS" : "FAIL", check.passed ? "pass" : "fail"); checkTable.appendChild(row);
  }
}

const COLORS = ["#56b4e9", "#e69f00", "#8fe0ae", "#cc79a7", "#f0e442", "#ff8a65", "#a78bfa", "#74d3c7"];
function renderWaveform() {
  const select = byId("signal"); const signals = [...new Set(DATA.waveforms.map(series => series.signal))];
  select.replaceChildren();
  for (const signal of signals) { const option = document.createElement("option"); option.value = signal; option.textContent = signal; select.appendChild(option); }
  const canvas = byId("chart"); const note = byId("waveform-note"); const legend = byId("legend");
  if (!signals.length) { select.disabled = true; note.textContent = "No waveform CSVs were included in the selected reports."; return; }
  const draw = () => {
    const chosen = select.value; const series = DATA.waveforms.filter(item => item.signal === chosen);
    const dpr = window.devicePixelRatio || 1; const width = Math.max(canvas.clientWidth, 360); const height = 390;
    canvas.width = width * dpr; canvas.height = height * dpr; const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, width, height);
    const pad = {left: 64, right: 18, top: 18, bottom: 42}; const plotW = width - pad.left - pad.right; const plotH = height - pad.top - pad.bottom;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const item of series) for (let i = 0; i < item.x.length; i++) { xmin = Math.min(xmin, item.x[i]); xmax = Math.max(xmax, item.x[i]); ymin = Math.min(ymin, item.y[i]); ymax = Math.max(ymax, item.y[i]); }
    if (xmin === xmax) xmax = xmin + 1; if (ymin === ymax) { ymin -= 1; ymax += 1; }
    const x = value => pad.left + (value - xmin) * plotW / (xmax - xmin); const y = value => pad.top + (ymax - value) * plotH / (ymax - ymin);
    ctx.font = "12px Segoe UI, sans-serif"; ctx.strokeStyle = "#334555"; ctx.fillStyle = "#aebdca"; ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) { const gy = pad.top + i * plotH / 5; ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(width - pad.right, gy); ctx.stroke(); ctx.fillText((ymax - i * (ymax - ymin) / 5).toPrecision(4), 5, gy + 4); }
    ctx.fillText(`${xmin.toPrecision(4)} s`, pad.left, height - 12); ctx.fillText(`${xmax.toPrecision(4)} s`, width - 75, height - 12);
    legend.replaceChildren();
    series.forEach((item, index) => {
      const color = COLORS[index % COLORS.length]; ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.beginPath();
      item.x.forEach((value, point) => { if (!point) ctx.moveTo(x(value), y(item.y[point])); else ctx.lineTo(x(value), y(item.y[point])); }); ctx.stroke();
      const entry = document.createElement("span"); const swatch = document.createElement("i"); swatch.className = "swatch"; swatch.style.backgroundColor = color; const label = document.createElement("span"); label.textContent = item.label; entry.append(swatch, label); legend.appendChild(entry);
    });
    note.textContent = `Showing ${series.length} run/scenario traces. Each trace uses up to ${MAX_DISPLAY_POINTS} evenly spaced display samples; archived CSVs remain unchanged.`;
  };
  select.addEventListener("change", draw); window.addEventListener("resize", draw); draw();
}
const MAX_DISPLAY_POINTS = 2000;

function renderDiffs() {
  const target = byId("diffs");
  if (!DATA.diffs.length) { target.textContent = "Supply two or more reports to compare archived scenario decks."; return; }
  for (const diff of DATA.diffs) { const heading = document.createElement("h3"); heading.textContent = diff.label; const pre = document.createElement("pre"); pre.textContent = diff.text; target.append(heading, pre); }
}

function renderBoms() {
  const target = byId("boms");
  if (!DATA.boms.length) { target.textContent = "No BOM data supplied."; return; }
  for (const bom of DATA.boms) {
    const title = document.createElement("h3"); title.textContent = `${bom.name} · snapshot ${bom.snapshot || "date not recorded"}`; target.appendChild(title);
    const wrap = document.createElement("div"); wrap.className = "table-wrap bom"; const table = document.createElement("table");
    const head = document.createElement("thead"); const header = document.createElement("tr"); for (const label of ["Reference", "Qty", "Manufacturer part", "Supplier part", "Stock snapshot", "Availability timestamp", "Datasheet"]) addHeaderCell(header, label); head.appendChild(header); table.appendChild(head);
    const body = document.createElement("tbody");
    for (const item of bom.items) { const part = item.part || {}; const row = document.createElement("tr"); addCell(row, item.reference); addCell(row, item.quantity); addCell(row, `${fmt(part.manufacturer)} ${fmt(part.manufacturer_part_number)}`); addCell(row, `${fmt(part.supplier)} ${fmt(part.supplier_part_number)}`); addCell(row, fmt(part.supplier_stock_quantity)); addCell(row, part.availability_price_snapshot_utc || bom.snapshot || "Not timestamped"); const cell = document.createElement("td"); const url = part.manufacturer_datasheet; if (typeof url === "string" && url.startsWith("https://")) { const link = document.createElement("a"); link.href = url; link.textContent = "Manufacturer datasheet"; cell.appendChild(link); } else { cell.textContent = "Not linked"; } row.appendChild(cell); body.appendChild(row); }
    table.appendChild(body); wrap.appendChild(table); target.appendChild(wrap);
  }
}

renderTables(); renderWaveform(); renderDiffs(); renderBoms();
</script>
</body>
</html>"""


def build_dashboard(
    report_paths: list[Path], output_path: Path, bom_paths: list[Path] | None = None
) -> Path:
    if not report_paths:
        raise EDAError("Provide at least one report.json file")
    data = _dashboard_data(report_paths, bom_paths or [])
    output_key = os.path.normcase(str(output_path.resolve()))
    input_keys = {os.path.normcase(path) for path in data.pop("_input_paths")}
    if output_key in input_keys:
        raise EDAError("Dashboard cannot overwrite an input artifact")
    page = HTML_TEMPLATE.replace("__DATA__", _script_json(data))
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(page, encoding="utf-8")
    except OSError as exc:
        raise EDAError(f"Cannot write dashboard {output_path}: {exc}") from exc
    return output_path
