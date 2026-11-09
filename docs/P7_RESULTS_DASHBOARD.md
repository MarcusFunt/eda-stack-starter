# Offline verification dashboard — Milestone 1

Run edastack dashboard to combine archived reports, waveform CSV, simulator decks, logs, and optional BOM snapshots into **one self-contained, read-only HTML page**.

Example from the repository root:

~~~powershell
edastack dashboard build/tscircuit-rc/reports/nominal/report.json build/tscircuit-rc/reports/resistor_fault/report.json --bom examples/rc_operating_cases/bom.json --out build/dashboard/index.html
~~~

Open the output HTML directly in a browser. No server, cloud access, JavaScript package install, or network connection is required to view it.

## Capabilities

- **Honest status semantics:** *Passed* requires a recorded successful measurement with a numeric upper and/or lower limit. Numeric values without limits are *Measured* and are **not** counted as verified. Explicit recorded failures remain *Failed*. Missing values/unfinished checks are *Not run*, and recorded execution errors are *Error*. Scenario status prioritizes errors, failures, and unfinished checks.
- **Failure-first inspection:** failing and errored checks are surfaced above other results. The measurement table sorts errors, failures, unrun measurements, measured-only results, and verified passes.
- **Filtering:** search by project, run ID, scenario, category, parameters, or measurement name. Filter by project and status; reset with one button.
- **Measurement units:** SI-prefixed values on supported electrical/time units, formatted consistently within an acceptance-limit row.
- **Waveform exploration:** select a signal; toggle per-run traces; drag to zoom, scroll to zoom around the pointer, reset the range, and click twice for two time cursors. Hover shows the nearest displayed sample. The original waveform CSV is unchanged.
- **Peak-preserving sampling:** traces with more than 2,000 samples use per-bucket minima and maxima per signal, preserving a narrow isolated spike that uniform index sampling could omit. Displayed traces contain up to 2,000 samples; full CSV files remain authoritative.
- **Run comparison:** choose baseline and candidate; compare only the *same project*, same-named scenarios, and same measurement IDs. Numeric deltas are shown only when units match.
- **Archived evidence:** select a scenario to inspect the report, netlist, simulator log, waveform CSV, and raw waveform references. Text previews are capped at 16 KiB per artifact, and links point to original local files.
- **Deck differences:** archived simulator deck diffs compare runs only within a project. They do not establish schematic or PCB equivalence.
- **BOM:** manufacturer/supplier parts, datasheets, inventory snapshots, and timestamps. These are not live stock availability or quotes.

## Tests

Python regressions cover status semantics, a single-sample spike, evidence availability, and cross-project safety:

~~~sh
python -m unittest tests.test_dashboard tests.test_dashboard_m1 -v
~~~

Browser interaction tests use Playwright and **real Chromium/Chrome**, without mocking the canvas or DOM:

~~~sh
cd tests/browser
npm ci
npm test
~~~

On a machine with a custom Python executable, set EDA_PYTHON to the installed interpreter for this repository. By default the browser suite uses system Chrome; set EDA_BROWSER_CHANNEL=chromium and install Chromium with npx playwright install chromium if Chrome is unavailable. The GitHub Actions dashboard-browser job installs Chromium and runs the tests.

## Boundaries

This is an archived-results browser: it does not execute simulations, edit circuits, certify electrical safety, or replace ERC/DRC and release-gate decisions. Original-file links require the source files to still be accessible from the browser. Copying the HTML preserves embedded previews and waveforms but not external file availability. Because provided report paths may refer to local files, supply only trusted inputs.

A graph rendered with fewer than all source samples must not be used to certify switching peaks, ringing, current stress, or transient safety. Review source data, simulator settings, component models, and explicit limits before any hardware decision.
