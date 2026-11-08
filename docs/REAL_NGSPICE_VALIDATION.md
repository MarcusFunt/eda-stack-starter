# Real ngspice validation

**Run date:** 2026-11-07

**Source revision:** `2d6f590721e8f42cfa6daf159fb04f13dbc992ea`

**Host:** Windows x64, Python 3.11.4

**Simulator:** ngspice 47 x64, console executable `C:\tools\ngspice-47\Spice64\bin\ngspice_con.exe` in the recorded Windows setup

**Archive:** `ngspice-47_64.7z`, SHA-256 `59225971bd68cdd1199443649aa4615a9e6d684933f205ab49006a3942518f5a` (matches the hash shown on the ngspice SourceForge download page)

**Version output:** ngspice-47, compiled with KLU; creation date Aug 11 2026.

The Windows binary was downloaded from the official [ngspice download page](https://ngspice.sourceforge.io/download.html), which lists the stable release and its 64-bit Windows archive. `NGSPICE_EXE` is set at user scope to the console binary path above.

## Additional nonconvergence proof — 2026-11-08

The test fixture `tests/fixtures/nonconvergent_behavioral.cir` forces `v(n) = v(n)^2 + 1`, which has no real operating-point solution. The real ngspice 47 host run and digest-pinned Docker run both failed closed with exit code 1. Their logs record failed dynamic/true gmin and source stepping, `Transient op failed, timestep too small`, and the failed transient operating point; neither report passed or produced a finite measurement.

| Mode | Run ID | Report and log |
|---|---|---|
| Host ngspice 47 | `c4b2becb9903449f98a834bc96725bf4` | `build/p0_2_nonconvergent_host/` |
| Pinned Docker image | `4b84a9a46a424c7a9fdc716645efc8fc` | `build/p0_2_nonconvergent_docker/` |

`tests/test_real_ngspice.py` now runs the fixture in the CI real-ngspice job and asserts that the timestep/operating-point failure remains a failed scenario with its log retained for the test duration.

## Commands and output

```powershell
$env:NGSPICE_EXE = 'C:\tools\ngspice-47\Spice64\bin\ngspice_con.exe'
$env:PATH = (Split-Path $env:NGSPICE_EXE) + ';' + $env:PATH
python -m unittest discover -s tests -p test_real_ngspice.py -v
edastack verify examples/rc_filter/spec.json --out build/ngspice47/rc_filter
edastack verify examples/diode_clamp/spec.json --out build/ngspice47/diode_clamp
```

All four real-ngspice tests passed with no skips, including missing-model and inconsistent-source failure cases. Both example specs passed all three scenarios. The latest RC run ID is `5a4d22905a4c47df9a2b77a685dc8306`; the latest diode-clamp run ID is `7e926a08809d4519af1fbf6f497e3bfc`. Each report, scenario deck, and simulator log is retained under `build/ngspice47/<project>/runs/<run-id>/`; the top-level report and `run_manifest.json` identify the latest run.

## RC filter results

| Scenario | Vout at 100 µs | Vout peak | Deck SHA-256 |
|---|---:|---:|---|
| nominal | 3.16059 V | 4.90842 V | `b5f2af3dbc9cf2990de324810a6b00e52a535ace1dffa5385fd6caff249b82fb` |
| fast_corner | 3.54519 V | 4.96416 V | `b00b4160c2251f083c88544b69729980ec09baee873fef9c693ab166cf1a0131` |
| slow_corner | 2.81198 V | 4.81665 V | `cd83f1cb5a8a3df6c941bd7b948ad0c669853e0039005abe9e9221f8945820f5` |

For nominal R=1 kΩ and C=100 nF, the analytic reference at 100 µs is `5*(1-exp(-1)) = 3.1606027941 V`. The simulated value differs by `0.0000128 V`, inside the integration test's `0.02 V` tolerance.

## Diode clamp results and bound review

| Scenario | Positive peak | Negative peak | Result |
|---|---:|---:|---|
| nominal | 0.679925 V | -4.99999 V | pass |
| low_resistance | 0.684872 V | -4.99999 V | pass |
| high_resistance | 0.675458 V | -4.99999 V | pass |

For this illustrative `D(IS=2n, N=1.8, RS=0.2)` diode model and ±5 V sine source, the positive bound `[0.5, 1.2] V` captures the forward-clamped peak observed across the three resistor cases. The negative bound `[-5.01, -4.0] V` captures the intended negative swing remaining close to the source minimum. These are demonstration bounds for this simplified model, not datasheet limits or hardware-safety evidence.

## Limits of this evidence

This is a real Windows ngspice run, not a mock simulation. It verifies the included decks and current checks under the listed cases only. It does not establish model fidelity for a physical diode, cover untested temperatures or faults, validate a schematic-to-SPICE mapping, or prove a global worst case. At the time of this validation, GitHub Actions had not yet been run against a remote repository.
