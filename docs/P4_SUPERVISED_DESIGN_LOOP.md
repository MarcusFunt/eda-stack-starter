# P4 supervised source-to-simulation loop

The tscircuit RC example has a small, reproducible candidate workflow. The versioned source is `integrations/tscircuit-rc/design.json`; `build-spice.mjs` derives tscircuit Circuit JSON and SPICE from those values. `verify.mjs` checks source-pin/net equivalence against the generated SPICE graph and runs the original requirement bounds through the EDA Stack verifier and real ngspice.

## Connect Codex to verification

Register the read-only verification service as `edastack` from the project root. Update the ngspice path if it is installed elsewhere:

```powershell
$projectRoot = (Resolve-Path .).Path
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
$ngspice = 'C:\tools\ngspice-47\Spice64\bin\ngspice_con.exe'
codex mcp add --env "EDA_STACK_ROOT=$projectRoot" `
  --env "NGSPICE_EXE=$ngspice" `
  edastack -- $python -m edastack.mcp
codex mcp get edastack
```

The tscircuit source tool is invoked as a pinned local Node program from `integrations/tscircuit-rc`; the agent can review and edit `design.json` through the project workspace. Traces is a separate sourcing MCP.

## Candidate procedure

From `integrations/tscircuit-rc`, record agent metadata and run one candidate at a time:

```powershell
$env:EDASTACK_CANDIDATE_MODEL = 'agent model/version'
$env:EDASTACK_CANDIDATE_PROMPT_ID = 'prompt or task revision'
git diff -- design.json
npm run candidate:verify
```

`candidate:verify` prints the tracked diff, permits changes only to `integrations/tscircuit-rc/design.json`, builds the source, checks pin/net equivalence, and compares measurements against the unchanged `examples/rc_filter/spec.json`. It records hashes, measurements, run IDs, the Git revision, tool versions and agent metadata in ignored `build/tscircuit-rc/optimization-history.jsonl`.

The workflow permits at most three attempts in that history file. Exit code 0 means all unchanged checks pass; 1 means a complete, clean simulator run measured a requirement violation; 2 means invalid source, a blocked diff, timeout, incomplete measurements, simulator errors, or other execution problems. Candidate provenance resolves Python from the project's active virtual environment on both Windows and POSIX. Every outcome stays pending human review. The runner does not edit requirements, delete tests, modify models, accept or commit the design, or trigger manufacturing actions.

As a recorded failure case, changing the source resistor to `3k` must leave the original bounds intact and fail at least the 100 µs output check. Correcting the source back to `1k` must pass. This demonstrates a bounded supervised loop, not a self-authorizing optimizer. The path guard is not an OS sandbox; ordinary filesystem permissions and human review remain part of the trust boundary.

See [`P4_SUPERVISED_LOOP_VALIDATION.md`](P4_SUPERVISED_LOOP_VALIDATION.md) for the failure/correction run IDs, hashes, measurements, and regression evidence.
