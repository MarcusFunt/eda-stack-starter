# tscircuit source-to-ngspice spike

## Result

On 2026-11-07, the pinned tscircuit RC source was compiled to Circuit JSON, converted to SPICE by the published converter, and simulated by the EDA Stack verifier using ngspice 47 x64 on Windows. The unmodified acceptance bounds from `examples/rc_filter/spec.json` were retained. The 1 kΩ / 100 nF nominal circuit passed all three measurements; the deliberately incorrect 3 kΩ resistor failed the 100 µs output and peak-output bounds.

The proof is repeatable with `npm ci` and `npm run verify` from `integrations/tscircuit-rc/`, provided the project `.venv` and an external ngspice installation are available. Generated logs and reports are ignored under `build/tscircuit-rc/`; the summary from the captured run is:

| Case | Circuit JSON SHA-256 | Converted SPICE SHA-256 | `vin_peak` | `vout_100u` | `vout_peak` | Result |
|---|---|---|---:|---:|---:|---|
| 1 kΩ / 100 nF | `225cdfbde7a2ba7e9f69f5c2fc19664f63a113ef03b79d050ba22561c35961e5` | `6e56bab97717754e2bd6a220db3939f98246a685e04b26b251139da49cf2011f` | 5 V | 3.16059 V | 4.90842 V | Pass |
| 3 kΩ / 100 nF fault | `b9870c126fce977670738b97e633e63a65e6bcb72d99ddbb7cc03937ffff50c2` | `56eabb0eecd2192aeae41e835a753ace9dc0417850271671ac52594c96894c55` | 5 V | 1.41734 V | 3.68201 V | Expected fail |

The source-to-SPICE manifest records source component IDs, ports, named source nets, traces, probes, converted component terminals, generated probe vectors, package versions, and SHA-256 hashes. The verifier independently checks source trace connectivity and converted terminal-node equality for the RC graph. VIN and VOUT probe bindings are checked against the source pins and generated SPICE nodes before simulator results are accepted.

## Converter behavior and scope

The source defines named `in`, `out`, and `GND` nets. The current converter resolves the correct component connectivity but emits anonymous SPICE nodes (`N1`, `N2`) instead of preserving `in` and `out`. The source's VIN/VOUT probes provide the stable node mapping used by the generated acceptance measurements. This behavior is recorded rather than silently assuming net names survive export.

The fixture is an electrical source-to-simulation proof, not a PCB or manufacturing proof. It does not verify physical footprints, symbols, ERC/DRC, layout, model fidelity beyond ideal passive components, or hardware safety. It is only evidence for this small RC circuit and these tested conditions.

## Dependency risk

The spike pins `tscircuit` 0.0.3114, `circuit-json-to-spice` 0.0.46, and peer `@tscircuit/math-utils` 0.0.36. The math-utils peer is pinned directly because the observed tscircuit dependency resolution otherwise failed at runtime with a missing `distSq` export. The separate `@tscircuit/cli` package is not used by this direct Circuit API and was removed from the package dependencies.

`npm audit` on the pinned dependency graph reported **29 advisories (23 high, 4 moderate, 2 low, 0 critical)**. npm's suggested automatic repair requires a semver-major downgrade of the tscircuit package, and the converter advisory suggests a major downgrade. No force-fix was applied. This spike is useful for compatibility evaluation, but its Node dependency set needs a reviewed upstream upgrade or mitigation before it is treated as a production dependency.
