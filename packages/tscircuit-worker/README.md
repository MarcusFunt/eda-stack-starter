# Circuit JSON to KiCad worker

This package converts arbitrary supported tscircuit Circuit JSON into an editable KiCad project. It calls the pinned `circuit-json-to-kicad` converters for schematic, PCB, project, and footprint output. It does not edit the existing RC template.

## Install and run

```sh
npm ci
npm test
npm run build
npm run export -- path/to/circuit.json build/my-design my-design
```

The export directory must not already exist. A successful export contains the root and any child schematics, `.kicad_pcb`, `.kicad_pro`, project symbol and footprint libraries, KiCad library tables, and `export-manifest.json` with input and artifact hashes. Unsupported or colliding physical pins fail before output is written.

Regenerate the checked-in fixtures with `npm run fixtures:generate` after `npm ci` in both this package and `integrations/tscircuit-rc`. `rc.circuit.json` is generated from the existing RC source; the two-resistor label and power-rail fixtures exercise different topologies.

## Build an authored TSX project

Project builds accept an `eda.project.json` manifest, its declared TSX entrypoint (for example `src/board.tsx`), reusable local TSX modules, and the project metadata files `requirements.json`, `parts.lock.json`, and `pcb.constraints.json`. The manifest pins the authoring backend, toolchain profile, metadata paths, and human release approval policy. Project dependencies are restricted to the exact React and tscircuit versions provided by the compiler image; project lockfiles, install scripts, and `node_modules` are rejected and never mounted or executed.

Build and run the local sandbox from the repository root:

```sh
cd packages/tscircuit-worker
npm ci
npm run sandbox:image
npm run build:project -- --project-root ../../benchmarks/fixtures/led-transistor --entrypoint src/board.tsx --output-dir ../../build/led-transistor
```

The sandbox image is tied to the compiler package lock hash. Rebuild it after changing that lock. Each successful output directory contains validated `circuit.json`, a deterministic `source-graph.json`, the complete source and build manifests with hashes, and the KiCad project emitted by the same converter used for direct Circuit JSON exports. Existing output directories are refused rather than overwritten.

The Python service adapter is `edastack.adapters.tscircuit.build_tscircuit_project`; it invokes this CLI with an argument array and returns the artifact paths and graph counts. It does not provide a shell or dependency-install hook.

### Project build trust boundary

The host validates and hashes the project snapshot before execution. It rejects symbolic and hard links, special files, path traversal, oversized projects, extra runtime dependencies, and unsupported metadata. Container execution has no network, a read-only root and source mount, no added capabilities, `no-new-privileges`, one CPU, 1 GiB memory, 64 processes, and bounded execution, logs, and output scratch. The Docker daemon and host kernel remain trusted; this is container isolation, not a hardened virtual machine. Builds fail with explicit diagnostics when TSX, project features, or Circuit JSON record types are unsupported.

The pinned tscircuit runtime currently reports 29 transitive npm audit advisories (2 low, 4 moderate, and 23 high). A forced upgrade would replace the tested tscircuit version and has not been applied. The compiler is isolated as above, but these advisories remain open and must be triaged before exposing this worker as a general build service.

The voltage-divider, LED/transistor, and LDO/sensor fixtures exercise passive, connector, transistor, reusable-module, and multi-sheet topologies. The native harness also adds a connector and resistor to a copied LED TSX source and checks that topology changes while the worker implementation hash remains fixed. Fixture `parts.lock.json` records topology-only metadata as unverified; the fixtures do not claim sourced or manufacturing-ready parts.

## Native KiCad evidence

With Docker available, run:

```sh
npm run verify:native
```

The script builds fresh RC Circuit JSON and the three authored projects in the isolated TSX sandbox, exports them through the general converter, opens and renders each schematic to SVG with KiCad 10.0.8 CLI, exports native netlists, runs ERC/DRC, and compares exact physical pin membership. It also verifies a malformed TSX failure and an execution timeout leave no success directory, and checks that the source-only LED mutation does not alter worker code. CI uploads the full report under the ignored repository `build/tscircuit-worker-native-*/verification-summary.json` directory. A zero exit code means export, native rendering, and exact pin-net parity passed; check `status`, `erc_status`, and `pcb_drc_status` for the separate ERC/DRC disposition.

ERC and DRC findings are collected without waivers and change the report status to `review_required`; they are not treated as passing checks. In the current KiCad 10.0.8 run the three new base projects reported 16/32/54 ERC findings and 9/12/19 PCB DRC violations, respectively. The expanded LED mutation reported 40 ERC findings and 18 PCB DRC violations. These are topology/export fixtures, not clean ERC/DRC acceptance or manufacturing evidence.

With `circuit-json-to-kicad@0.0.270` and KiCad 10.0.8, all three fixtures currently preserve exact physical pin membership, including the two-resistor auto-label topology and the power-rail topology. KiCad resolves the exported symbol libraries without missing-library findings. The report status is currently `connectivity_pass_native_findings_present`: ERC reports grid-alignment/disconnected-endpoint warnings and `power_pin_not_driven` errors (19 findings for RC, 11 for the two-resistor fixture, and 16 for the power-rail fixture). The generated unrouted PCBs also report DRC findings. These are included in each report without waivers; a clean graph check must not be mistaken for a clean ERC/DRC result.

The reduced tests experimentally show that converter 0.0.270 preserves pin membership for these reproductions of upstream issue [#549](https://github.com/tscircuit/circuit-json-to-kicad/issues/549) and [#595](https://github.com/tscircuit/circuit-json-to-kicad/issues/595). This does not establish that arbitrary circuits or all versions of either case are correct. Coordinate rounding was rejected because a local experiment split previously connected pins in KiCad's native netlist. Portable symbol libraries are instead built from the converter's embedded symbol definitions, keeping the exported symbol geometry and references consistent.

The upstream package does not declare all runtime imports in its published manifest, so the worker pins those direct runtime imports explicitly in `package.json` and `package-lock.json`. Keep them aligned with the converter version and the runtime-entrypoint test. Zod is overridden to patched version 4.6.6 because the converter's compatible `circuit-json` runtime accepts it; the complete worker suite and native proof run with that override, and `npm audit --omit=dev` is clean.
