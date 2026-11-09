# Typed circuit constraints and Topola placement-mutation experiment

**Date:** 2026-11-09. **Branch:** feat/typed-constraints-topola.
**Base:** origin/main 01ae82f. The experiments ran on Marcus_Computer.

## Experiment 1: typed electrical constraints

Implemented in `src/edastack/experimental_constraints.py`:

- Decimal SI quantities and dimension-checked voltage, current, resistance, power intervals.
- Typed electrical pin IDs and signal domains with driver/receiver/passive directions.
- Named nets, unique physical-pin ownership, multiple-driver, domain-mismatch, and single-pin diagnostics.
- Voltage incompatibility detection that checks the **full driver range** against receiver limits.
- Deterministic canonical JSON, SHA-256 source identity and conservative E24 resistor-divider search.

The test case is 11.4–12.6 V input, required 3.0–3.6 V output,
1% resistor tolerance, max divider current 1 mA and conservative resistor
power bound 125 mW. The selected E24 pair is **24 kΩ / 9.1 kΩ**,
with computed worst-case output **3.0889–3.5145 V**, maximum current
**0.38451 mA** and conservative top resistor power **3.584 mW**.

**Tests:** 10 unit tests, including contradictions, wrong dimensions,
partial driver/receiver overlap and multi-pin reset regression.
This is *not* a transistor-level circuit simulation, manufacturable
parts selection or full Faebryk constraint solver.

Reproduce from the project root with installed package or PYTHONPATH=src:

```powershell
python -m edastack.experimental_constraints --output build/experiments/typed-constraints.json
python -m pytest tests/test_experimental_constraints.py -q
```

## Experiment 2: real Topola DSN to SES to KiCad DRC

**Upstream revision:** mikwielgus/topola commit
`666e06cfd7ba1f1e5daf700288acb9e0a4f84ceb`.
Rust 1.99.1 debug build on Ubuntu WSL; native KiCad 10.0.8.
Fixture: Topola's MIT-licensed through-hole diode bridge example,
copied into `experiments/topola/fixtures` with source attribution.

**Design:** 4 nets, 2 copper layers. Default Topola CLI routes on layer 0.
Shift diode D3 horizontally by 0, -1 and -2 mm in both the source DSN
placement and the corresponding native KiCad PCB. Generate SES from
scratch in each case, import with pcbnew.ImportSpecctraSES, then run
native KiCad DRC. No waivers or ignored checks.

Original unrouted board: 12 DRC findings and 8 unconnected items.

| D3 shift | Original Topola time (s) | SES wire geometry (mm) | DRC default 100 µm | DRC diagnostic 200 µm | Post-route unconnected |
|---:|---:|---:|---:|---:|---:|
| 0 mm | 0.2829 | 183.1287 | 211 | 60 | 0 |
| -1 mm | 0.2241 | 183.3237 | 212 | 61 | 0 |
| -2 mm | 0.2129 | 183.6697 | 224 | 73 | 0 |

All six sessions were generated; each enumerates all four source nets.
All six were imported and DRC checked in KiCad.

**Failure analysis:** The original Topola CLI hardcodes
`routed_band_width: 100.0` micrometers although the source DSN requires
200 µm. Its baseline reported 199 track-width findings. A diagnostic
local build changing ONLY this CLI source literal from 100 to 200 µm
reduced the baseline to **48 track-width findings**, plus the
original 12 footprint/silkscreen violations. This remaining 0.001 mm
copper artifact must be diagnosed at export/import level, not waived.
A -1 mm mutation introduces an additional courtyard overlap; -2 mm
causes further courtyard and silkscreen conflicts.

**Important:** The reported lengths sum all SES wire path geometries,
including auxiliary/original paths. They are not pure newly routed copper
lengths. A successful Topola exit, four output net names, and zero
unconnected items do NOT demonstrate DRC-clean routing or connectivity
proof against a complete schematic.

### Reproduce

In WSL, clone and build Topola:

```bash
git clone https://github.com/mikwielgus/topola.git topola
cd topola
git checkout 666e06cfd7ba1f1e5daf700288acb9e0a4f84ceb
cargo build -p topola-cli
```

In WSL, from this EDA repository root:

```bash
python3 experiments/topola/benchmark.py \
  --topola /absolute/path/to/topola/target/debug/topola \
  --out build/experiments/topola/my-run
```

On Windows, from the same repository root, invoke KiCad's embedded Python:

```powershell
& "D:\Programs\KiCad\10.0.8\bin\python.exe" experiments\topola\import_and_drc.py --out build\experiments\topola\my-run --kicad-cli "D:\Programs\KiCad\10.0.8\bin\kicad-cli.exe"
```

For the diagnostic variant only, change the 100.0 to 200.0
`routed_band_width` literal in the cloned Topola CLI source, rebuild,
and rerun in a new output directory. No Topola source edits were
committed into this project. Both benchmark binaries are fingerprinted.

Create a machine-readable portable summary of both runs:

```powershell
python experiments\topola\summarize_results.py --default build\experiments\topola\my-run\report.json --width200 build\experiments\topola\my-width200\report.json --output experiments\topola\results\my-summary.json
```

Committed result: `experiments/topola/results/bridge-placement-2026-11-09.json`.
Original detailed evidence remains in ignored paths
`build/experiments/topola/bridge-run1` and `bridge-width200-run1`.

## Conclusions and next milestones

1. **Constraints:** Next add a TSX/Circuit JSON adapter with stable
   physical pin identity, manufacturer parts and independent native parity.
2. **Simulation:** Connect selected values to model-backed ngspice
   verification. Analytical divider feasibility is not sufficient for release.
3. **Topola:** Propagate DSN-specific min trace width and clearance rather
   than a hardcoded default; diagnose why 0.001 mm geometry is imported.
4. **Placement:** Legalize moved footprints before routing; keep native DRC
   as a fail-closed acceptance criterion.
5. **Topological route reuse:** Not implemented or demonstrated here.
   The experiment measures **fresh reroutes** after moving D3.
   A future true homotopy benchmark must preserve obstacle identities and
   obstacle-side relationships, regenerate routes from saved topology and
   measure retained unaffected copper. Multilayer via routing is also untested.

These experiments make no manufacturing-release claim.
