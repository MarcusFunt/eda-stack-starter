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

## Native KiCad evidence

With Docker available, run:

```sh
npm run verify:native
```

The script builds fresh RC Circuit JSON from the existing RC source, exports all three fixtures, opens and renders each schematic to SVG with KiCad 10.0.8 CLI, opens each board, exports native netlists, runs ERC/DRC, and compares exact physical pin membership. It asserts that each native SVG contains the source component references. The full machine-readable report is written under the ignored repository `build/tscircuit-worker-native-*/verification-summary.json` directory. A zero exit code means conversion and pin-net parity passed; check `status`, `erc_status`, and `pcb_drc_status` in the report for native-check disposition.

With `circuit-json-to-kicad@0.0.270` and KiCad 10.0.8, all three fixtures currently preserve exact physical pin membership, including the two-resistor auto-label topology and the power-rail topology. KiCad resolves the exported symbol libraries without missing-library findings. The report status is currently `connectivity_pass_native_findings_present`: ERC reports grid-alignment/disconnected-endpoint warnings and `power_pin_not_driven` errors (19 findings for RC, 11 for the two-resistor fixture, and 16 for the power-rail fixture). The generated unrouted PCBs also report DRC findings. These are included in each report without waivers; a clean graph check must not be mistaken for a clean ERC/DRC result.

The reduced tests experimentally show that converter 0.0.270 preserves pin membership for these reproductions of upstream issue [#549](https://github.com/tscircuit/circuit-json-to-kicad/issues/549) and [#595](https://github.com/tscircuit/circuit-json-to-kicad/issues/595). This does not establish that arbitrary circuits or all versions of either case are correct. Coordinate rounding was rejected because a local experiment split previously connected pins in KiCad's native netlist. Portable symbol libraries are instead built from the converter's embedded symbol definitions, keeping the exported symbol geometry and references consistent.

The upstream package does not declare all runtime imports in its published manifest, so the worker pins those direct runtime imports explicitly in `package.json` and `package-lock.json`. Keep them aligned with the converter version and the runtime-entrypoint test. Zod is overridden to patched version 4.6.6 because the converter's compatible `circuit-json` runtime accepts it; the complete worker suite and native proof run with that override, and `npm audit --omit=dev` is clean.
