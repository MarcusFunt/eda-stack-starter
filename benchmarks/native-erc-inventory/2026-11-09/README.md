# Native ERC inventory — 2026-11-09

This evidence bundle records a fresh sandbox TSX build and pinned KiCad 10.0.8 CLI run for each general fixture. The raw exports, Circuit JSON, source graphs, build and converter manifests, native ERC JSON, native netlists, PCB DRC JSON, rendered schematic SVGs, aggregate fault inventory, and toolchain metadata are retained beside this report. `evidence-manifest.json` hashes every retained evidence file; transient `.kicad_prl` user preference files are excluded.

## Results

| Fixture | Native pin/net parity | ERC findings | Ignored ERC checks |
| --- | --- | ---: | --- |
| `voltage-divider` | Exact | 3 | 0 |
| `led-transistor` | Exact | 5 | 0 |
| `ldo-sensor-interface` | Exact | 6 | 0 |

The 14 findings are classified in `erc-fault-inventory.json`:

- 14 custom-footprint library lookup findings from KiCad CLI (3 voltage-divider, 5 LED/transistor, 6 LDO/sensor)

The exporter now normalizes schematic electrical anchors to KiCad's 50 mil grid while preserving marker syntax. The earlier unconnected endpoint / grid geometry findings are gone, and exact pin/net membership holds across all current fixtures. No ERC checks are ignored.

Two smaller Circuit JSON cases are archived under `reduced-repros/` for quick reproduction: `two-resistor-labels` and `power-rail` each report 2 custom-library and 2 power-pin findings. Their source Circuit JSON, native schematic, export manifest, ERC JSON, native netlist, DRC report, and rendered SVGs are included. These reduced counts are separate from the three general fixtures above.

The fresh source snapshots are archived under each fixture's `source/` directory. Connector supply and ground pins, IC supply pins, the regulator output, required sensor signals, and the regulator's intentional no-connect are declared in TSX. LED/transistor and LDO local branches use explicit pin-to-pin traces; single-sheet net labels have local scope, while hierarchical designs keep cross-sheet labels global. The exporter trims only verified free wire tails that overshoot a single on-wire label. Grid normalization also preserves KiCad's two-coordinate junction/no-connect syntax; emitting a synthetic zero-degree marker angle had split LDO nets and is covered by a regression test. Current connectivity and endpoint checks pass.

Exact native pin/net parity is a connectivity result. It does not mean the schematics pass ERC or that the boards pass DRC. The verification summary retains the PCB DRC findings separately.

## KiCad custom-library limitation

The generated `tscircuit.pretty` footprint files and project-local `fp-lib-table` are present in each export. KiCad 10.0.8 CLI still reports that the custom `tscircuit` nickname is not in its active configuration; a local reproduction also tried a temporary global table. The same class of CLI behavior is tracked upstream in [KiCad issue #24684](https://gitlab.com/kicad/code/kicad/-/work_items/24684). These findings remain in the inventory and are not suppressed.

## Reproduction

From the repository root, with Docker available:

```powershell
npm --prefix packages/tscircuit-worker ci
npm --prefix packages/tscircuit-worker run verify:native
```

The recorded pinned tools and image hashes are in `toolchain-metadata.json`; `verification-summary.json` records the implementation hash and the negative malformed-source / timeout build checks. This run was based on commit `af170a4933918fe376f998b44280cd07234f79bf` with source and exporter changes under review.

The strict schematic gate was rerun against the fresh LED/transistor and LDO/sensor reports; its machine-readable result is `release-check-schematic.json`. It rejected both fixtures for unresolved ERC findings. Unit regressions confirm that unconnected wire endpoints, undriven power pins, missing required pins, and nonempty or missing ignored-check lists block release.
