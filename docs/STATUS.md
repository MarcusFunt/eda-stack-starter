# Implementation status — 2026-11-08

## Implemented

- Dependency-free Python package with CLI commands: `doctor`, `verify`.
- Configurable ngspice subprocess calls with per-corner rendered netlists.
- Numeric upper/lower limits, missing-value and non-finite failure cases.
- Named resistor/capacitor tolerance corners, validation and controlled template substitution.
- Generated `report.json`, `report.md`, `measurements.csv`, and `run_manifest.json`; each invocation archives scenario decks and logs in a unique run directory.
- Minimal stdio MCP endpoint: `tools/list`, `tools/call`, `initialize`, `ping`.
- Case-insensitive duplicate measurement names and unsupported duplicate analysis kinds are rejected.
- A real deliberately nonconvergent behavioral-source fixture fails with ngspice's timestep/operating-point diagnostics in both Windows host and digest-pinned Docker runs; the failure test is part of the real-ngspice suite.
- The verification-spec JSON Schema validates both committed examples; Ruff lint is configured for Python source and tests.
- Named transient analyses can coexist; measurements bind explicitly when analysis kinds repeat. Native ngspice `.meas` directives cover peak, average, RMS, rise time, and other supported quantities, with peak times preserved when the engine reports them.
- Waveform requests write raw ngspice data and normalized CSVs with sample counts, time ranges, column names, and SHA-256 hashes. Missing, malformed, non-finite, and non-monotonic waveform data fail the case.
- Explicit Cartesian sweeps generate deterministic case names and are capped at 32 scenarios. Reports label the finite grid and make no statistical or global worst-case claim.
- Model-source metadata and measurement `model_ref` values are included in reports alongside case parameters, signal, units, measured value, and limits.
- Versioned local model catalog and verification-spec mappings are validated against SHA-256 checksums, explicit subcircuit header pin order, model includes, and component-to-net pin maps. Catalog entries record provenance and limitations; the local two-pin fixture passes on ngspice 47.
- Reports distinguish nominal, corner, fault, and listed statistical-sample categories, retain explicit untested-condition notes, parse convergence failures, and check exported transient intervals against ngspice's configured maximum timestep. Analyses without waveforms are marked unchecked.
- The eight-case RC operating example passed all supply, selected RC/load, startup, load-step, and shutdown checks on ngspice 47. Each exported waveform's maximum sample interval was 0.2 µs, matching its configured transient maximum step. Full Windows suite: 53 tests, 0 skipped; Ruff and `pip check` pass. Evidence: `build/p2_3_rc_operating_v2/` and `build/p2_3_full_tests.txt`.
- A date-stamped source-linked BOM maps the 1 kΩ / 100 nF example to exact YAGEO MPNs returned by Traces. Values and ratings were checked against YAGEO product sheets; 0603 package drawings and pad numbers were checked against hashed KiCad 10.0.8 standard footprints. The live 2026-11-08 JLCPCB/LCSC query returned current stock/price snapshots but no supplier timestamp, MOQ, or lead time. BOM regression tests cover derating arithmetic and mapping metadata.
- Two small sample decks: RC filter and nonlinear diode clamp.
- A pinned tscircuit RC source-to-SPICE spike checks source pin connectivity, probe mapping, and generated SPICE node connectivity before real-ngspice verification. The Ubuntu CI job installs the lock and exercises the same nominal/fault acceptance proof.
- A native KiCad RC template now receives R1/C1 values from the freshly generated tscircuit Circuit JSON/SPICE manifest; strict source checks reject other component sets or RC connections. The validator exports and structurally checks Gerber copper/mask/paste/silkscreen/edge layers, Excellon drills, and a BOM-linked front-side position file with a saved board origin. KiCad 10.0.8 validation passes ERC 0, board DRC 0, unconnected items 0, and schematic/PCB parity 0. Component selection and PCB geometry remain in the reviewed template; general-purpose tscircuit-to-KiCad export remains unintegrated, and this fixture is not a fabrication release. Evidence and limitations: `docs/P5_KICAD_INTERCHANGE_VALIDATION.md`.
- A fixture-specific RC resistor power screen compares the BOM's worst-case supply/resistance calculation and measured ngspice startup power with the manufacturer rating and validated KiCad copper geometry. It passes the BOM's 50%-of-rating limit under the declared ≤70 °C ambient assumption; no package-to-board temperature rise is estimated. Details: `docs/P7_RC_THERMAL_SCREENING.md`.
- An opt-in Docker executor runs ngspice per scenario with inspected network/filesystem/privilege settings and memory, CPU, PID, tmpfs, input-size, and time limits. RC nominal/corners, a recursively included model file, and the deliberate resistor fault were exercised in the pinned image. Procedure and evidence: `docs/P7_DOCKER_ISOLATION.md`.
- A dependency-free offline dashboard combines experiment matrices, measured limits, waveform overlays, BOM snapshots, and archived scenario-deck diffs. It does not claim schematic or PCB equivalence. Procedure: `docs/P7_RESULTS_DASHBOARD.md`.

## Revalidation after review — 2026-11-08

- Windows ngspice GUI-alias handling was exercised against the installed ngspice 47 executables: `doctor` resolved `ngspice.exe` to `ngspice_con.exe`, and the real RC example passed all three scenarios without opening the GUI.
- The full Windows Python suite passed 82 tests with real ngspice and no skips. Ruff and `pip check` passed. After a clean `npm ci`, the tscircuit integration suite passed 26 Node tests and `npm ls --depth=0` showed only the three declared dependencies.
- A clean Ubuntu 24.04 container installed the workflow-pinned ngspice 42 package and `requirements-dev.txt`; its full Python suite also passed 82 tests, including real ngspice and MCP-client coverage. This is local container evidence, not a hosted GitHub Actions run.
- The native KiCad generator produced the project under `build/tscircuit-rc/kicad-generated/` from current source values. KiCad 10.0.8 reported ERC 0, DRC 0, unconnected 0, and schematic/PCB parity 0. The validator checks generated values and footprints against the source design and BOM, plus the full component set and SPICE topology.
- The source-directed native-template implementation passed the full Node suite (33 tests), tscircuit nominal/fault acceptance, and a clean KiCad 10.0.8 generation/validation pass. It changes R1/C1 values only; footprint and PCB geometry generation remain outside this fixture adapter.
- The same validator generated seven required Gerber layers, the Gerber job file, separate empty PTH/NPTH drill files for this all-SMD board, drill maps/report, and a front-side placement CSV containing exactly BOM items R1/C1. Their headers, edge bounds, hashes, and origin-relative coordinates are recorded in the local manufacturing manifest.
- The Docker-isolated RC example passed all three scenarios after every Docker CLI output channel received a host-memory cap. Container inputs are size-checked before reading; status, logs, and waveforms use bounded reads that reject symlinks and special files.
- The tscircuit nominal/fault proof passed: nominal meets all original bounds, while the 3 kΩ fault fails on a finite, out-of-range 100 µs measurement with no simulator errors. Candidate runs with incomplete or errored evidence are classified as infrastructure/source failures.
- The deliberately nonconvergent behavioral circuit failed closed on both host ngspice 47 and the pinned Docker image; both reports preserve the exact timestep/operating-point diagnostics and log path. See `docs/REAL_NGSPICE_VALIDATION.md`.
- After the final native KiCad review, fail-closed checks now cover the original tscircuit source graph (including omitted converter components and unknown trace identities), numeric SPICE value normalization, disjoint/no-symlink output paths, stale-success cleanup, hardlinked output targets, and blank placement fields. Revalidation passed 45 Node tests, all 82 Python tests with real ngspice 47 enabled, Ruff, `pip check`, and KiCad 10.0.8 ERC/DRC/parity with zero findings.

## Verified with real ngspice

- ngspice 47 x64 was run on Windows on 2026-11-07. Both example specs passed all three scenarios, and all four real-engine integration tests passed without skips.
- Failure behavior was exercised against a missing external model and inconsistent ideal voltage sources; both failed with scenario-specific machine-readable errors and log paths.
- The nominal RC result was 3.16059 V at 100 µs versus an analytic reference of 3.1606027941 V (absolute error 0.0000128 V).
- Details, measured corners, deck hashes and local report paths are recorded in `docs/REAL_NGSPICE_VALIDATION.md` and `build/ngspice47/`.
- The full Windows suite passed: 36 tests in 5.1 seconds, 0 skipped, using `NGSPICE_EXE` pointed at the console binary so no GUI is launched. This includes real ngspice, the MCP Python client, and schema validation; output is retained at `build/p2_1_full_tests.txt`.
- After adding automatic Windows console-binary selection, the offline dashboard, and BOM mapping validation, the full suite passed 72 tests with 0 skipped when the ngspice `bin` directory was on `PATH`. `edastack doctor` and a real RC verification resolved `ngspice.exe` to its sibling `ngspice_con.exe`; see `docs/INSTALL_WINDOWS.md`.
- The P2.1 real-ngspice resistor sweep ran at 4/5/6 V. Peak resistor power was 15.9998/24.9997/35.9996 mW at 1 ns against a 20 mW check limit; only the 4 V case passed. Each case exported 2,021 waveform samples. Local evidence: `build/p2_1_resistor_overstress/`.
- P2.2 versioned model library passed on ngspice 47 with the two-pin fixture reporting 0.500 V; the report records library/model hashes and pin metadata. Full Windows suite: 47 tests, 0 skipped; Ruff and `pip check` pass. Evidence: `build/p2_2_model_fixture/` and `build/p2_2_full_tests.txt`.
- RC rise-time checks and resistor RMS/average-power measurements passed on ngspice 47. Device-current extraction uses ngspice `savecurrents`, whose values can lag one transient timestep; timestep selection remains part of the engineering judgment.

## Blocked / not yet verified

- The reproducible Ubuntu/Windows workflow is configured; hosted GitHub Actions validation of the public repository is still pending.
- The tscircuit simulation spike and generated native KiCad handoff cover only a small RC design with fixed KiCad symbols, footprints, and PCB geometry. The board has not been fabricated or bench-tested, and general-purpose tscircuit-to-KiCad geometry export is not integrated. A local LLM runtime is not integrated into this repository.
- The pinned Node tscircuit dependency graph currently reports 29 npm audit advisories (23 high); see `docs/TSCIRCUIT_SPIKE.md` before treating it as a production dependency.
- Catalog source, license, manufacturer, operating-range and rating statements remain author-supplied provenance; model files, hashes, declared subcircuit pin order and mapped circuit connectivity are checked. No statistical/Monte Carlo, thermal or signal-integrity verification is implemented.
- P7 remains partial: Docker isolation, the offline results dashboard, and an RC electrical power/derating screen are implemented and locally validated. The screen does not estimate component temperature rise; parasitic extraction is not warranted for this low-frequency reference; no current fixture requires another simulator backend; and a protected release pipeline remains future work.
- GitHub Actions has not yet been reviewed on the newly published public repository.

## Next concrete milestones

1. Review component fit and the generated manufacturing files with a fabricator before any board order.
2. Review the initial GitHub Actions run on the public repository and fix any CI-only issues.
