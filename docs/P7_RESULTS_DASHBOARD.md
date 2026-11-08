# Offline results dashboard

`edastack dashboard` converts existing EDA Stack `report.json` files, their archived waveform CSVs and optional BOM JSON files into one self-contained HTML file. The page runs locally in a browser and makes no network requests. Python's standard library builds it; no dashboard package is installed.

```powershell
edastack dashboard <baseline-report.json> [candidate-report.json ...] `
  --bom examples/rc_operating_cases/bom.json `
  --out build/dashboard/index.html
```

The page includes:

- A run/scenario matrix with category, parameter values, check count and pass/fail status.
- Numeric measurement results alongside their minimum/maximum limits.
- Selectable waveform-signal overlays across all supplied run/scenario CSVs. The HTML display samples up to 2,000 evenly spaced points per trace; the source CSV files remain unchanged.
- Manufacturer part, supplier part, stock snapshot, timestamp and datasheet links from BOM files. These values are historical API snapshots, not live inventory or purchase quotes.
- Unified diffs of the archived simulator input decks. The first report is the baseline; each later report is diffed against its first scenario with a same-named scenario preferred when present.

The diff shows the simulator deck consumed for verification. It does not establish schematic, footprint, or PCB equivalence. The dashboard does not change reports or specifications, run simulations, assess physical layout, or certify hardware. Keep BOM snapshots refreshed and review all source artifacts separately.
