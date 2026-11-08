# AI agents, tscircuit and Traces

## Verification tool for your coding agent

This package can expose local ngspice runs through an MCP stdio server. After `python -m pip install -e .`, generate an absolute path to the root folder and configure your agent. The example under `integrations/opencode.v2.example.json` targets the **OpenCode v2 `mcp.servers` configuration**. OpenCode has different docs/config shapes for older versions: adapt to the actual installed version.

The agent can invoke `verify_spice_spec` with `examples/rc_filter/spec.json`, inspect the numeric checks, and fix the source design as a separate, **reviewed** edit. The agent cannot change design files through this MCP service itself.

For the tscircuit RC candidate workflow, the sole permitted source edit is `integrations/tscircuit-rc/design.json`. Show the diff and run `npm run candidate:verify` from `integrations/tscircuit-rc`; the script stops if any other tracked project file changes, preserves the checked-in requirement bounds, checks source-to-SPICE equivalence, and records each result. It is a review guard, not an OS security boundary. Human review remains required before accepting or committing a candidate.

### Bring-your-own-model

The MCP server is model-neutral. Use OpenCode configured with Ollama or an OpenAI-compatible local provider. This package makes no LLM calls. Source-of-truth lives in your design repository; don't allow an agent to overwrite vendor models, experiment specs, or validated references without review.

### tscircuit RC integration

The pinned `integrations/tscircuit-rc` project builds a small RC Circuit JSON/SPICE source and verifies it with ngspice. Its KiCad adapter propagates values into a reviewed fixed-topology template; symbol choice, footprints, geometry, and routing are not generated from Circuit JSON. See that integration's README and `docs/P5_KICAD_INTERCHANGE_VALIDATION.md` for commands, checks, and limits.

### traces sourcing (separate MCP service)

Repository: https://github.com/usetraces/traces

The developer documents installation of its **stdio MCP sourcing service** via:

```
git clone https://github.com/usetraces/traces.git
cd traces
./install.sh mcp
```

The recommended client command in its README is shaped like:

```
uv run --directory /path/to/traces/mcp traces-mcp
```

Configure that service as a separate MCP server in your agent. It provides `source_component`, `find_datasheet`, `netlist_check`. Leave `OPENROUTER_API_KEY` empty and set `OLLAMA_MODEL` for local inference. JLCPCB/LCSC can work without supplier API keys; the other distributors may need API credentials.

This repository does not implement traces' supplier APIs and does not bundle the Traces application. A separate local Traces MCP was installed and exercised on 2026-11-07; the test returned JLCPCB/LCSC candidate records and the selected parts were checked against YAGEO specification sheets. The dated snapshot and limits are recorded in `examples/rc_operating_cases/BOM.md` and `docs/TRACES_MCP_SETUP.md`.

**Important:** stock and price are volatile supplier data. The captured API result omitted a source timestamp, quantity break, MOQ, and lead time; use its local capture time only as provenance and refresh the supplier record before ordering. LLM candidate text is not a datasheet. Digi-Key and Mouser access remains untested because credentials are not configured.

## MCP trust model

`edastack-mcp` only accepts a JSON spec path beneath `EDA_STACK_ROOT` and saves its artifacts in a `build/agent` subfolder. Host mode runs the configured local ngspice executable. Docker mode is opt-in per verification call and constrains mounts, network, privileges, CPU, memory, process count, writable temporary storage and runtime. **Review external SPICE models before simulation.** The Docker daemon and host kernel remain trusted; container mode is not a hardened virtual machine. The server also prevents `.control` sections directly in its top-level input. See `docs/P7_DOCKER_ISOLATION.md` for the tested configuration and remaining limits.
