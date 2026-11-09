# EDA Stack Starter — Phase 1 (v0.1)

A free, local-first **SPICE verification layer** intended to sit beneath tscircuit, KiCad, or another AI design agent. It runs electrical tests with **real ngspice** (when installed), captures named analyses and waveforms, compares measured values with limits over explicit operating/tolerance cases, and returns reproducible **JSON, CSV and Markdown reports**. It has a read-only-to-source MCP server for OpenCode or another AI agent.

**Current evidence:** both included examples have been simulated with real ngspice 47 on Windows, including tests for missing models and an inconsistent circuit. Per-run reports and immutable scenario artifacts are retained. See `docs/STATUS.md` and `docs/REAL_NGSPICE_VALIDATION.md`.

## Quick start (Windows PowerShell)

1. Install a Windows x64 ngspice binary. ngspice 47 is the version validated for this starter; see `docs/INSTALL_WINDOWS.md`.
2. Install Python 3.10+ and confirm `py --version`.
3. Open PowerShell inside this extracted folder:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
edastack doctor
```

If `doctor` doesn't find ngspice, set `NGSPICE_EXE` to the full path of the ngspice console executable (for the validated archive, `ngspice_con.exe`):

```powershell
$env:NGSPICE_EXE = 'C:\path\to\ngspice_con.exe'
edastack doctor
```

Then run the first electrical test:

```powershell
edastack verify examples/rc_filter/spec.json --out build/rc_filter
edastack verify examples/diode_clamp/spec.json --out build/diode_clamp
```

To run each scenario in the optional resource-limited Docker boundary, first pull the digest-pinned image:

```powershell
docker pull kicad/kicad@sha256:3f4a01786dfbe803a65f345c3342b765db9add913f5e9448f8356793714ddc34
edastack verify examples/rc_filter/spec.json --out build/rc_filter_isolated --isolation docker
```

Container mode requires Docker, reports the image's ngspice version, blocks network access, stages only the netlist and referenced files read-only, and records the applied resource limits. It is optional; host execution remains the default. See `docs/P7_DOCKER_ISOLATION.md` for its trust boundary and validation evidence.

To create a self-contained offline dashboard from archived runs, pass reports in baseline-then-candidate order and optionally add source-linked BOM files:

```powershell
edastack dashboard build/tscircuit-rc/reports/nominal/report.json build/tscircuit-rc/reports/resistor_fault/report.json --bom examples/rc_operating_cases/bom.json --out build/dashboard/index.html
```

The self-contained HTML page prioritizes failures, distinguishes **measured-only** values from verified limits, filters runs and measurements, supports waveform zoom/cursors/trace selection, compares same-project runs, opens archived evidence, and shows BOM snapshots. It uses peak-preserving display sampling while retaining original waveform CSVs. Browser interaction tests and scope limitations are described in `docs/P7_RESULTS_DASHBOARD.md`.

The CLI returns exit code **0 on PASS**, **1 on limit or simulation failure**, and **2 for bad configuration/missing tools**. Check `build/rc_filter/report.md` and the JSON/CSV results. Each invocation writes a unique snapshot under `build/rc_filter/runs/<run-id>/` and refreshes the top-level report and `run_manifest.json`. No cloud calls or paid APIs are made.

## Linux / macOS

```bash
# Install system ngspice using your distro package manager or Homebrew.
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
edastack doctor
edastack verify examples/rc_filter/spec.json --out build/rc_filter
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
```

See `docs/INSTALL_WINDOWS.md` for binary discovery and limitations.

## The pipeline currently implemented

```text
EDA tool / design agent writes SPICE netlist
                |
          spec.json
   (analysis, checks, corners)
                |
          edastack verify
                |
       ngspice executable
                |
   numeric .meas measurements
                |
   limit comparison for each case
                |
    report.json / .csv / .md
                |
          AI agent reviews
```

The source netlist must have a title line and **not include a `.control` block**. `edastack` adds the analysis and measurement control commands itself. Analyses support `tran`, `ac`, and `dc`; multiple analyses of one kind require named analysis objects and an explicit analysis reference on each measurement. Optional waveform requests produce raw ngspice data plus canonical CSV files with sample counts and SHA-256 hashes. Numeric limit checks can include units, a signal expression, a source-model reference, and the reported time of a peak. A versioned model library records checksummed files, pin order, physical-pin maps, source/license details, and operating assumptions. See `docs/MEASUREMENT_FRAMEWORK.md` for the spec fields and limits.

Only scalar parameters using SPICE numeric literals are supported for templating; this avoids injecting arbitrary ngspice control commands via agent-provided parameter values. Native vendor model `.include` and `.lib` paths may require care with their working directory; see `docs/VERIFICATION.md`.

## Agent integration

The project provides a zero-dependency **stdio MCP server** (`edastack-mcp`). After installation, it exposes:

- `eda_toolchain_status`: check whether ngspice is installed.
- `verify_spice_spec`: execute all corners in a supplied spec and return per-measure pass/fail outcomes, saving all files under `build/agent/...`.

Set `EDA_STACK_ROOT` to this project's absolute folder and `NGSPICE_EXE` to ngspice if not on PATH. See `integrations/opencode.v2.example.json` and `docs/AGENTS.md`. The server does not let an LLM edit source netlists directly. Any AI agent with ordinary filesystem editing access must be supervised and source changes reviewed.

## Intended complete EDA stack

| Layer | Preferred | Status |
|---|---|---|
| EDA authoring | tscircuit | **Small tscircuit RC source-to-SPICE and native handoff verified** |
| Simulation & verification | ngspice + this harness | Implemented; exercised with real ngspice 47 on Windows |
| Agent integration | Codex + local MCP services | Traces sourcing and read-only verification MCP registered; source edits remain reviewed |
| Sourcing | traces via its separate MCP | Installed and exercised locally; source-linked example BOM recorded |
| Native KiCad handoff | KiCad CLI 10.0.8 | RC template adapter passes ERC/DRC; separate general Circuit JSON worker matches native pin-net membership on three fixtures, with ERC/DRC review findings still open |
| Final PCB layout | KiCad | The reference board still needs physical fit and fabricator review before release |

Avoid routing decisions or fabrication until schematic correctness, model quality, electrical limits, ERC/DRC, and physical checks have been independently verified.

The general Circuit JSON to KiCad export spike is documented in [`packages/tscircuit-worker/README.md`](packages/tscircuit-worker/README.md). It is not yet integrated as the repository's general authoring or manufacturing pipeline.

## Included examples

- `examples/rc_filter`: RC 5 V step-response, resistor/capacitor tolerance corners, peak and time-point checks.
- `examples/diode_clamp`: nonlinear diode clipper, positive and negative peak checks across resistor corners. Uses a simplified illustrative diode model.
- `examples/resistor_overstress`: explicit 4/5/6 V sweep, named transient analyses, waveform export, RMS/average/peak resistor power, and a deliberate 20 mW limit violation at 5 V and 6 V. The resistor is modeled as an ideal primitive; its power rating is an example check limit, not a component datasheet rating.
- `examples/rc_operating_cases`: eight tagged nominal and corner cases covering 4.5/5.0/5.5 V supply, selected RC and pulsed-load values, startup, load-step, and shutdown measurements. The report states the untested conditions and checks exported transient intervals against ngspice's maximum-step setting.
- `examples/rc_operating_cases/BOM.md` and `bom.json`: dated JLCPCB/LCSC snapshot for YAGEO 1 kΩ and 100 nF 0603 parts, datasheet-checked ratings, derating assumptions, and footprint/model pin maps. The simulated circuit still uses ideal SPICE primitives.
- `models/library.json`: versioned model catalog used by the resistor example, with a pinned local two-pin subcircuit fixture in `models/fixtures/`. The fixture verifies model-file and validation-fixture checksums, declared pin order, include resolution, and instance connectivity with real ngspice; it is not a vendor part.

## Development

```bash
python -m unittest discover -s tests -v
```

The full development lock and MCP integration test require Python 3.11 or later; Python 3.10 remains supported for the runtime package and mock/unit tests. Ruff lint and example-spec JSON Schema checks are included in CI. The test suite includes a **fake ngspice executable** to test subprocess plumbing and report generation without pretending to simulate a circuit. Real ngspice tests skip when the engine is missing. See `docs/TOOLCHAIN_VERSIONS.md` for the tested version policy.

## Provenance and safety

Every scenario archives a rendered SPICE netlist, ngspice log, requested waveforms, SHA-256 hashes, version string, scenario parameters, measurement provenance and limit results. An explicit sweep covers only the listed finite cases; it is not a global worst-case or statistical result. The model loader verifies referenced file identity and circuit pin mapping, while source, license, operating-range and limitation records remain author-supplied provenance; it does not certify vendor ratings. A simulation report does not certify hardware safety. SPICE can underestimate peaks if model parasitics, operating cases, timestep or convergence are wrong. Only run trusted netlists/model files: arbitrary SPICE control scripts or external model files can have unsafe side effects.

License: MIT for this starter's code (external tools retain their own licenses).
