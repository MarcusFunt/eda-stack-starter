# P4 supervised loop validation

Validated on 2026-11-07 with Node 24.15.0, Python 3.11.4, EDA Stack 0.1.0, tscircuit 0.0.3114, `circuit-json-to-spice` 0.0.46, and ngspice 47. Candidate records are preserved in the local ignored file `build/tscircuit-rc/optimization-history.jsonl`.

## Guard test

The test temporarily changed `design.json` and appended a newline to the required RC spec. `candidate:verify` refused to run with exit code 2 and reported that only `integrations/tscircuit-rc/design.json` may change. The spec and source files were restored byte-for-byte after the check. Its SHA-256 remained `8913837ed6aca02b628c10a0335b93945ed0707928014c89d1b4b8e6379f8312` for both actual candidate runs.

## Candidate history

| Iteration | Source value | Candidate | Result | V(out) at 100 µs | Rise time | Peak V(out) | Run ID |
|---:|---:|---|---|---:|---:|---:|---|
| 1 | R = 3 kΩ, C = 100 nF | `p4-1-778dc1330b73` | Failed unchanged requirements | 1.41734 V (fail) | unavailable (fail closed) | 3.68201 V | `8fd74c41562c4c98a9174598e20e0835` |
| 2 | R = 1 kΩ, C = 100 nF | `p4-2-70ad6583a0b5` | Passed unchanged requirements | 3.16059 V | 219.722 µs | 4.90842 V | `e1fa02461cb142d8b0d3e401a4079575` |

The 3 kΩ candidate's generated deck SHA-256 was `a16b07dbdd82936aefc41e92127c818d761007938cdc9f4ecc39d4b82dbf90a4`; its source-to-SPICE circuit JSON SHA-256 was `b9870c126fce977670738b97e633e63a65e6bcb72d99ddbb7cc03937ffff50c2`. The corrected candidate's deck SHA-256 was `7f04ebede919f28986622e35397075ea4b4270f02a71f197e351c3c05fef91a2`; its circuit JSON SHA-256 was `225cdfbde7a2ba7e9f69f5c2fc19664f63a113ef03b79d050ba22561c35961e5`.

Both attempts recorded the same immutable requirement-spec hash above, candidate source hashes, generated SPICE hashes, run IDs, runtime/package versions, model label `GPT-6 via Codex; exact runtime build not exposed`, and prompt ID `P4 roadmap acceptance demonstration 2026-11-07`. Both remain marked `pending_review`; the workflow does not accept or commit a design automatically. The source file is back at the committed 1 kΩ / 100 nF values with no outstanding diff.

## Regression evidence

- `npm test`: 4 tests passed, 0 skipped.
- `npm run verify`: the tscircuit-generated nominal source passed; the deliberate 3 kΩ fault failed as expected. The converter's source-pin, generated-net, SPICE-node, and probe mappings were checked.
- `.venv/Scripts/python.exe -m unittest discover -s tests -v`: 53 tests passed, 0 skipped, including real ngspice and stdio MCP tests.
- Ruff check/format, `pip check`, Node syntax checks, BOM JSON parse, and `git diff --check` passed.
