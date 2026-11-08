# Measurement and analysis framework

Version 1 specs may keep the existing analysis command strings or use named analysis objects. Named objects let a project run multiple transient analyses without confusing which one a measurement uses:

```json
"analyses": [
  {"id": "startup", "command": "tran 0.2u 400u"},
  {"id": "startup_fine", "command": "tran 0.1u 10u"}
]
```

Each measurement can declare its `analysis`, `signal`, `unit`, and `model_ref`. If there is only one analysis of the directive's kind, `analysis` is inferred for older specs. If there are multiple candidates, it is required. The `.meas` directive remains an ngspice measurement command, so `MAX`, `AVG`, `RMS`, `PP`, `FIND`, trigger/target rise time, and supported AC/DC measurements are expressed with ngspice syntax. edastack reports the numeric result and supplied unit; it does not infer or convert units. For `MAX`/`MIN` output that includes an `at=` field, the report also stores `time_s`.

Measurements with a mathematical signal expression can put that expression in `signal`; edastack turns it into a named ngspice vector before evaluating the measurement. It supports voltage differences such as `V(in,out)` and resistor current syntax such as `I(R1)`. Current vectors are requested only when needed. ngspice's `savecurrents` option provides those vectors; the ngspice manual notes that current data can be delayed by one transient step, so choose a timestep that is suitable for the quantity being checked. See [ngspice User's Manual, current measurements](https://ngspice.sourceforge.io/docs/ngspice-manual.pdf).

## Explicit sweeps

A sweep defines named axes. edastack evaluates the Cartesian product of the listed values and combines those cases with any explicit scenarios:

```json
"parameters": {"V": "5", "R": "1k"},
"sweeps": [
  {"name": "supply", "values": {"V": ["4", "5", "6"]}}
]
```

The expansion is deterministic and limited to 32 total scenarios. Reports identify the method as `explicit_cartesian_grid` and set `statistical_sampling` to `false`. Listed corners describe only those tested points; they are not a global worst case or Monte Carlo result.

Each scenario may declare a `category`: `nominal`, `corner`, `fault`, `statistical_sample`, or `other`. The default category is `nominal` only for a scenario named `nominal`; other cases default to `corner`. A spec may include `untested_conditions`; if it omits the field, the report gives a general statement that all conditions beyond listed cases and model assumptions remain untested. Reports enumerate nominal cases, tested corners, fault cases, and any user-listed statistical samples. The runner itself does not generate statistical samples.

## Waveform exports

Waveform entries name one analysis and one or more unambiguous vectors:

```json
"waveforms": [
  {"id": "startup_nodes", "analysis": "startup", "signals": ["v(in)", "v(out)", "i(R1)"]}
]
```

Each scenario keeps ngspice's raw `wrdata` file and a normalized CSV with `time_s` followed by the requested signals. The report records the sample count, time span, columns, and SHA-256 hashes for both files. Missing, malformed, non-finite, or non-monotonic exports fail the scenario.

## Versioned model library and pin mapping

Projects may point to a checked-in model catalog with `model_library` and map each used netlist component using `id`, `component`, `library_ref`, and a physical `connections` object. `schemas/model-library.schema.json` describes the catalog; `schemas/verification-spec.schema.json` describes the spec mapping. A catalog entry records model kind, source, version, license, manufacturer/part number where known, operating-condition bounds and their basis, assumptions, limitations, ordered logical pins, and physical pin numbers.

For a subcircuit entry, the catalog includes a relative model-file path and SHA-256. The runner checks the file hash, checks the declared pin order against the `.SUBCKT` header, requires the netlist to include that file, checks the instance name and subcircuit, and compares the mapped physical pins with the netlist terminals. Validation-fixture files have their own required SHA-256. Built-in primitives identify their SPICE designator and still require a pin map and validation fixture. Paths are kept within the project/library folders. Missing models, checksum changes, and inconsistent maps fail spec loading before a simulation can pass.

For example, the resistor-overstress spec maps `R1` to `ngspice_ideal_resistor`; the library says its physical pins 1 and 2 connect to the netlist's first and second resistor terminals. `models/fixtures/ideal_two_pin_spec.json` exercises the subcircuit form with a real ngspice simulation. Its model is a local fixture, not a vendor part. The catalog's rating fields, source, license, assumptions, and limitations are provenance declarations supplied by the catalog author; the runner verifies file identity and wiring, not the truth of a datasheet or license statement. A measurement's `model_ref` attaches the selected model record to its result. The resistor example's 20 mW limit remains a demonstration check, not a datasheet rating.

## Solver and timestep quality

The report keeps convergence/timestep failure text from ngspice and makes those cases fail closed. For transient analyses with waveform exports, it records minimum, median, and maximum sample intervals and checks that the largest interval does not exceed the analysis maximum-step limit. The limit is explicit `tmax` when supplied; otherwise ngspice uses the smaller of `tstep` and `(tstop - tstart) / 50`. See the [ngspice User's Manual](https://ngspice.sourceforge.io/docs/ngspice-manual.pdf). Transient analyses without exports are marked `not_checked_no_waveform`; passing this check does not prove the circuit was modeled adequately or that all behavior was captured.
