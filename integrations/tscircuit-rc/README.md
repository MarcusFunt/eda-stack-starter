# tscircuit RC to SPICE spike

## Native KiCad handoff

The `kicad/` directory contains a reviewed native KiCad template for the passive 1 kΩ / 100 nF RC test fixture. Each validation run rebuilds the tscircuit Circuit JSON and SPICE manifest from `design.json`, then writes the validated R1/C1 values into a generated project under `build/tscircuit-rc/kicad-generated/`. TP1 is the input, TP2 is the output, and TP3 is ground; the stimulus source used in the SPICE example is external to the board. The schematic uses standard Device, Connector, and power symbols, and the board uses standard Resistor_SMD, Capacitor_SMD, and TestPoint footprints.

Run `npm run kicad:validate` after `npm ci` and with Docker available; the pinned KiCad image is pulled if missing. The command rebuilds the tscircuit-to-SPICE source manifest, checks the original source component/pin/net graph, generates the native project from the template, exports its schematic netlist, runs ERC, board DRC, and schematic/PCB parity, and creates Gerber, Excellon drill, and front-side placement outputs. The source adapter only propagates R1/C1 values for the fixed RC topology; it rejects other source or SPICE component sets and connections. Symbol choices, footprints, board geometry, routing, and test-point topology remain in the reviewed KiCad template. The command fails if source values disagree with the BOM, fabrication outputs do not match the board/BOM, or any KiCad finding appears. It clears prior reports and generated project files before starting, so a failed run cannot leave a stale success summary. Reports, board statistics, a 3D preview, a hashed manufacturing manifest, and a validation summary are written under `build/tscircuit-rc/kicad-validation/`.

The KiCad project is a reviewed reference for this small, low-frequency fixture. It does not establish fabrication readiness or hardware behavior. The headless 3D render in the pinned container displays board geometry and pads but does not include resistor/capacitor bodies, so check component fit in a local KiCad installation before treating it as a manufacturing release. Export validation is structural and does not replace a fabricator-specific file review.

This fixture uses pinned tscircuit source and its published Circuit JSON to SPICE converter. The converter receives the generated Circuit JSON; the SPICE netlist is not hand-authored. The resulting netlist feeds the existing `edastack` verifier, which runs the configured external ngspice binary.

From this directory, install the pinned Node dependencies with `npm ci`, then run `npm run build:spice`. To run the complete acceptance proof on Windows, set `NGSPICE_EXE` in the current shell to the ngspice executable and run `npm run verify`; on Linux, ensure `ngspice` is on `PATH` before running `npm run verify`. The project Python virtual environment must also be installed. The scripts emit Circuit JSON, the SPICE deck, a mapping/hash manifest, and verifier reports below the ignored `build/tscircuit-rc/` directory.

`verify.mjs` checks source pin connectivity against the converted SPICE graph and checks that VIN/VOUT probes still point to the intended source pins/nodes. It runs the unchanged RC bounds against the generated 1 kΩ / 100 nF design and then a deliberate 3 kΩ resistor fault. The nominal case must pass and the fault case must fail. This is a minimal source-to-simulation proof; it does not establish a full PCB or manufacturing flow.

## Supervised design-candidate loop

`design.json` is the only source file the candidate loop permits an agent to change. It stores bounded SPICE literals for the resistor and capacitor; arbitrary expressions or control text are rejected. Run:

```powershell
$env:EDASTACK_CANDIDATE_MODEL = 'Codex model/version used'
$env:EDASTACK_CANDIDATE_PROMPT_ID = 'task or prompt revision'
npm run candidate:verify
```

The command prints the Git diff, converts the source through tscircuit, checks source-to-SPICE pin/net equivalence, and verifies the candidate against the unchanged `examples/rc_filter/spec.json` bounds using real ngspice. It stores one record per attempt under ignored `build/tscircuit-rc/optimization-history.jsonl`, including input/output hashes, measured checks, run ID, package/runtime versions, and supplied model/prompt metadata. It allows at most three attempts per history file and fails closed on invalid source, a failed requirement, or a timeout.

Changes to any other tracked file, including requirements, tests, models, or verification code, stop the loop before simulation. This is a workflow guard, not a security sandbox: source changes still require human diff review. The runner never commits or accepts a candidate and never triggers manufacturing; keep `human_disposition` pending until a person reviews the diff and report. The candidate history can be restarted only by intentionally archiving or deleting its ignored history file.
