# Supported tool versions and CI policy

## Support policy

- **Python runtime:** 3.10 or later, as declared in `pyproject.toml`. CI exercises Python 3.10, 3.11, and 3.13 on Ubuntu 24.04 and Windows Server 2022. GitHub's setup action resolves each minor line to an available patch release; jobs record the selected Python version.
- **Python development tools:** the fully pinned `requirements-dev.txt` lock is for Python 3.11 or later because the MCP Python SDK is development-only and requires Python 3.11+. Python 3.10 CI installs only the runtime package; MCP-client and schema tests are skipped there.
- **ngspice:** the automated Linux integration job pins Ubuntu 24.04's `ngspice=42+ds-3build1` ([Ubuntu package record](https://packages.ubuntu.com/noble/ngspice)). Local users may use ngspice 42 or later; Windows ngspice 47 x64 is also validated in `REAL_NGSPICE_VALIDATION.md` using the [official download page](https://ngspice.sourceforge.io/download.html). No claim is made that every ngspice version has identical parsing or convergence behavior.
- **Node integration runtime:** the tscircuit CI job pins Node 24.15.0 and npm 11.12.1; `integrations/tscircuit-rc/package-lock.json` pins the project dependency graph.
- **EDA Studio web shell:** `apps/studio-web/package-lock.json` pins React/React DOM 19.3.0, React Router 7.18.5, Vite 8.3.6, `@vitejs/plugin-react` 6.2.1, and TypeScript 5.9.3. Run `npm ci` from that directory. The UI uses local system fonts and its Vite development proxy targets the loopback API; it does not require an external font or service.
- **tscircuit spike:** Node packages are isolated in `integrations/tscircuit-rc/` and pinned by `package-lock.json`; `npm ci` installs the lock. The tested source-to-SPICE path uses `tscircuit` 0.0.3114 and `circuit-json-to-spice` 0.0.46 with `@tscircuit/math-utils` 0.0.36 pinned as a peer compatibility dependency. The current dependency graph has 29 npm audit advisories; see `TSCIRCUIT_SPIKE.md`.
- **MCP Python SDK:** 2.3.0, development/test only.
- **JSON Schema and lint:** `jsonschema` 4.26.0 checks the committed example specs; Ruff 0.16.8 runs the configured lint rules. Exact test and transitive dependency pins are in `requirements-dev.txt`.
- **CI host images:** Ubuntu 24.04 and Windows Server 2022 are named explicitly rather than using rolling `*-latest` aliases. Action references use the checkout v4, setup-python v5, and upload-artifact v4 release lines. The real-engine job records Python, pip packages, and ngspice in the uploaded `build/toolchain.txt` artifact.

## Updating versions

Change the lock, CI pins, and this policy together. Run the full test suite with the real simulator, run both example specs, confirm the reports and logs are retained as CI artifacts, and record the versions in the evidence report. Review major-version changes for MCP protocol or simulator behavior before updating.

The schema validates document structure. `edastack` still performs runtime validation for safe parameter values, duplicate identifiers, file containment, and cross-field consistency.
