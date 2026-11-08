# Engineering verification policy

## What is verified automatically?

Each configured scenario executes a real ngspice process (once installed). Scalar `.meas` results are compared against configured min/max limits. Missing, non-finite, failed and timed-out measurements **fail closed**. Each invocation receives a unique run ID; its scenario inputs and logs are kept under `runs/<run-id>/`, alongside a run-specific report and manifest. Top-level reports point to the latest invocation without overwriting prior scenario evidence. Scenarios can be tagged `nominal`, `corner`, `fault`, or `statistical_sample`; reports list each group, conditions the spec says are untested, and explicitly avoid a global worst-case claim. The runner does not generate statistical samples.

Versioned model-library entries are checked for file hashes, declared subcircuit pin order, netlist include resolution, and component-to-net pin mapping. Source provenance, license statements, electrical ratings, and manufacturer claims are still author-supplied and are not independently certified. The build performs no BOM verification, schematic ERC/PCB DRC, thermal analysis, layout parasitic extraction, or hardware testing. No simulated result alone certifies circuit safety. Multiple analyses of the same kind are supported with named analysis objects; each measurement binds to one named analysis.

Transient reports parse solver failure messages and compare the largest exported waveform sample interval with the configured maximum transient step. The ngspice default maximum step is derived from the `tran` command: the smaller of `tstep` and one fiftieth of the simulated output interval; an explicit `tmax` takes precedence. This behavior follows the [ngspice User's Manual](https://ngspice.sourceforge.io/docs/ngspice-manual.pdf). Analyses without waveform exports are reported as unchecked for sampled-step quality. A passing interval check says only that the exported trace obeys this step bound; it does not prove that a model is valid or that all peaks or stability conditions were captured.

## What can go wrong?

- A vendor macro-model can omit important overshoot, reverse recovery, self-heating and switching phenomena.
- Incorrect SPICE node ordering can produce plausible yet wrong results.
- Large timesteps or simulator tolerances can hide fast ringing and maxima.
- A narrow set of corners is not a true global worst case. Monte Carlo alone never proves an absolute bound.
- Simulation may model a partial circuit with ideal supply sources, wires, EMI coupling or thermal conditions.
- A SPICE engine may converge to an incorrect operating point, or fail to find one.
- Host execution runs netlists and model files directly on the local machine; review external model code before simulation. The opt-in Docker mode restricts network, mounted files, privileges and selected resources, but the Docker daemon, host kernel and image remain trusted; see `P7_DOCKER_ISOLATION.md`.

## Recommended gate sequence

1. Define input/load/environment ratings and a traceable requirements document.
2. Source appropriate vendor models; compare model pin order, waveform behavior and limits to the actual datasheets.
3. Run nominal DC, transient and AC checks, where applicable.
4. Run voltage/load/temperature/tolerance corners; simulate faults where models support them.
5. Check waveform peaks, RMS values, dissipation and stability. For power electronics, add thermal and parasitic estimates.
6. Verify schematic ERC, BOM orderability/footprints, PCB DRC and sensitive layout loops.
7. Bench-test the hardware with protective limits and suitable instrumentation.

### Why we don't use ngspice `-r` in batch mode

The ngspice manual notes that using `-r rawfile` together with `-b` streams data to rawfiles and can prevent `.meas` from accessing the in-memory plot. We use `-b -o log` with a generated `.control` section instead. Add direct raw-data plotting/export only as a separate, tested feature.

## Sample theoretical RC reference

Input 5.0 V step, R=1 kΩ, C=100 nF, tau=100 µs. The idealized charging curve is `Vout(t)=5*(1-exp(-t/RC))` and at 100 µs it is ~3.1606 V. Nominal Vout at 400 µs is ~4.9084 V. Real ngspice results are recorded in `docs/REAL_NGSPICE_VALIDATION.md`.
