# Traces component sourcing MCP

Traces is installed as a separate local service. It is not a dependency of this repository and does not replace the `edastack-mcp` verification service.

## Example tested setup

- Upstream: [usetraces/traces](https://github.com/usetraces/traces)
- Checked-out revision: `000c1fd953dfd58c8f1bbac421e37356f95012d0`
- Example location: `C:\tools\traces`
- MCP package: `C:\tools\traces\mcp`
- Python environment: `mcp\.venv` (created by `uv sync`)
- Local inference: Ollama `gemma4`; no OpenRouter key configured
- Codex global MCP registration: `traces`, stdio transport, points at `mcp\.venv\Scripts\traces-mcp.exe`

## Install and register on Windows

With `git`, `uv`, Node.js/npm, and Ollama available:

```powershell
git clone https://github.com/usetraces/traces.git C:\tools\traces
Set-Location C:\tools\traces\mcp
uv sync
npm ci
Copy-Item ..\.env.example ..\.env
ollama pull gemma4
```

Leave `OPENROUTER_API_KEY` empty to use the local Ollama model. JLCPCB/LCSC searches do not need a supplier API key. Set the Mouser or Digi-Key credentials in `C:\tools\traces\.env` only if those sources are required.

Register the service in Codex, replacing `C:\tools\traces` with its actual location:

```powershell
codex mcp add traces -- "C:\tools\traces\mcp\.venv\Scripts\traces-mcp.exe"
codex mcp get traces
```

The MCP exposes `source_component`, `find_datasheet`, `model_info`, and `netlist_check`. A local smoke call to `model_info` reported `local (ollama): gemma4`. `source_component` successfully returned exact JLCPCB/LCSC candidates for the parts in [`../examples/rc_operating_cases/BOM.md`](../examples/rc_operating_cases/BOM.md), and `find_datasheet` returned the LCSC datasheet record for capacitor C14663.

## Limits of the current evidence

- The installed Traces 3.4.2 stdio MCP was rechecked on 2026-11-08 02:01:05 UTC using local Ollama `gemma4`. Exact-MPN JLCPCB/LCSC requests returned YAGEO RC0603FR-071KL / C22548 (14,118,671 in stock at $0.0036) and CC0603KRX7R9BB104 / C14663 (34,035,481 in stock at $0.0155), both with 0603 footprints. The responses had no source timestamps, so the BOM records the local UTC capture time. Refresh stock and price immediately before ordering.
- The price result has no associated tier, quote quantity, MOQ, shipping, tax, or lead time. Do not treat it as a purchase quote.
- Manufacturer data must be reviewed separately from LLM candidate text. This repository's BOM links directly to YAGEO specification sheets and records which attributes were checked.
- Digi-Key and Mouser were not exercised because their credentials are absent. No credential values are stored in this repository.
- The returned parts have not been substituted into a schematic or verified by ERC/DRC, a vendor model, or a physical prototype.
- The Traces `mcp` Node dependency lockfile was refreshed to Zod 4.6.7 after npm reported an advisory affecting versions below 4.6.6; `npm audit` then reported zero vulnerabilities.
