# Topola DSN → SES routing benchmark

**Result: experiment complete; do not integrate the tested Topola CLI into the PCB release path.** Measured Topola command wall time is below 0.8 seconds on these small cases, but every emitted routing candidate violates the board's minimum track width. It also fails to finish the swapped and crowded placements. The tscircuit router also fails those two harder placements, so neither tool is a general routing optimizer on this evidence.

## Results

All candidates used the same three-net source graph and the same KiCad board rules. `Routed` is the fraction of `VIN`, `MID`, and `GND` with no native KiCad unconnected item. Unconnected groups are reported separately from the DRC violation count, matching KiCad's JSON schema. DRC counts below include errors and warnings. The schematic-parity count is separate.

| Placement | Topola: routed, unconnected | Topola: DRC | Topola: copper / vias | Topola wall time | tscircuit: routed, unconnected | tscircuit: DRC | tscircuit: copper / vias | tscircuit build time |
| --- | --- | --- | --- | ---: | --- | --- | --- | ---: |
| Base | 3/3, 0 | 33 (24 track-width errors) | 57.100 mm / 0 | 664 ms | 3/3, 0 | 10 (1 hole-clearance error) | 31.248 mm / 2 | 6,063 ms |
| Translated | 3/3, 0 | 33 (24 track-width errors) | 57.100 mm / 0 | 663 ms | 3/3, 0 | 10 (1 hole-clearance error) | 31.235 mm / 2 | 5,977 ms |
| Swapped | 0/3, 4 groups | 73 (24 track-width errors plus shorts, mask bridges, and crossings) | 26.000 mm / 0 | 572 ms | 0/3, 4 groups | 17 (courtyard overlap, shorts, and mask bridges) | 0 mm / 0 | 5,825 ms |
| Crowded | 2/3, 1 group | 34 (24 track-width errors; courtyard overlap) | 40.337 mm / 0 | 784 ms | 0/3, 3 groups | 10 (courtyard overlap plus baseline warnings) | 0 mm / 0 | 5,925 ms |
| Fixed J1 | 3/3, 0 | 33 (24 track-width errors) | 58.463 mm / 0 | 702 ms | 3/3, 0 | 9 (warnings only) | 33.381 mm / 1 | 6,185 ms |

All five imports succeeded, and all five Topola sessions were parseable by KiCad. The measured DRC count therefore distinguishes a valid interchange from valid routing: SES import worked even where routing remained incomplete or copper was invalid. All candidates report 11 schematic-parity issues, unchanged from the fixture's existing native project. The five KiCad ignored-check keys are also unchanged and are included in every per-candidate metrics JSON.

### Why Topola is not suitable for integration yet

The SES files declare `(resolution um 1)` and Topola emits many paths with width `1`. KiCad imports those paths as **0.001 mm** tracks; the board minimum is **0.100 mm**. The native DRC catches this as 24 `track_width` errors in every scenario. The raw base SES and imported-board DRC report preserve this evidence. The base Topola route is about 1.83× the tscircuit candidate's copper length and uses no vias, but those apparent savings do not compensate for the invalid width.

The tscircuit comparison is not a clean manufacturing baseline either: the base and translated candidates each have one `hole_clearance` error. The fixed-J1 candidate has no DRC errors, only the fixture's warnings. Both tools leave the swapped and crowded layouts unrouted. These outcomes support continued router evaluation, not a release claim.

The fixed-J1 case holds connector J1 at its source coordinate while moving R1/R2. The router is given a completed placement in DSN; the DSN/SES route-only flow does not send a separate `fixed_components` placement-optimizer flag. The `pcb.constraints.json` file is preserved with each input.

## Measurement method

- Fixture: 24 × 14 mm, two copper layers, three components, seven physical ports, three named nets. The canonical source graph SHA-256 is `150287fc9cf64fcb53eb7f7a60ca3ab660608a7e098ea2a48156b6ee04480a2f`. This hash is identical for all five scenarios.
- Topola input: KiCad Python API `ExportSpecctraDSN`; session import: `ImportSpecctraSES`; both use the pinned KiCad 10.0.8 image.
- tscircuit comparison: the same fixture and coordinates with `routingDisabled` removed, compiled by the repository's pinned project sandbox. The Topola input build retains `routingDisabled`, yielding the common unrouted placement.
- Native verification: `kicad-cli pcb drc --schematic-parity --format json --severity-all`. Track length and via count are read back from the KiCad board using `pcbnew`.
- Topola runtime is host wall time around the router's Docker invocation (includes container startup; excludes DSN export, SES import, and DRC). tscircuit time is full project build wall time, so the timing numbers are operational measurements, **not** isolated router-speed comparisons.
- The Topola CLI exposes no seed argument. A second base run produced the same SES SHA-256 (`022a56a36149dc888fbb3ba7875abbcd1fc08be7507bd4436f30660013d9659c`), confirming deterministic output for that input.
- KiCad reports these five ignored-check keys on every candidate: `missing_courtyard`, `track_not_centered_on_via`, `tuning_profile_track_geometries`, `footprint_filters_mismatch`, and `footprint_type_mismatch`. The benchmark does not change the fixture rules or these existing settings; the track-width error remains enabled and reported.

## Reproduction and evidence

The run script checks out no code and writes only to a new output directory. It requires the pinned Topola source and build described below, Docker, Node/npm, and the repository's existing compiler sandbox image.

```powershell
# From the repository root; build Topola once as described in toolchain.json.
./benchmarks/topola-routing/2026-11-09/run.ps1 `
  -OutputRoot ./benchmarks/topola-routing/2026-11-09/runs/<new-run-name>
```

The checked-in run at [`runs/round2/benchmark-results.json`](runs/round2/benchmark-results.json) summarizes all five cases; [`runs/round2/results.csv`](runs/round2/results.csv) is the compact table. Each `runs/round2/<scenario>/` directory contains the exact source projects and build manifests, raw DSN and SES, imported KiCad board, DRC JSON/logs, tscircuit candidate board and DRC, and per-tool metrics. The repeated base SES and byte comparison are in [`runs/round2/repeat/`](runs/round2/repeat/). Placement coordinates are listed in [`mutations.json`](mutations.json). Toolchain pins and key artifact hashes are in [`toolchain.json`](toolchain.json) and [`artifact-hashes.json`](artifact-hashes.json).

To build the tested Topola binary, clone `https://github.com/mikwielgus/topola` into `build/topola-source`, check out commit `666e06cfd7ba1f1e5daf700288acb9e0a4f84ceb`, copy [`topola-Cargo.lock`](topola-Cargo.lock) to `build/topola-source/Cargo.lock`, then run the recorded `cargo build --locked --release -p topola-cli` command inside the pinned Rust image. The runner verifies the source commit and expects the binary at `build/topola-target/release/topola`.
