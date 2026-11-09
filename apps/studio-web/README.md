# EDA Studio web shell

This is the local React/Vite interface for EDA Studio. It currently provides routed workspace placeholders, responsive navigation and inspector drawers, and status from the local API. It does not yet create/import projects or edit source.

## Run locally

Install the Python package once from the repository root using the project's Python environment:

```powershell
python -m pip install -e .
```

Start the API from the repository root:

```powershell
edastack-studio
```

Then start the web shell in another terminal:

```powershell
Set-Location apps/studio-web
npm ci
npm run dev -- --host 127.0.0.1 --port 5173
```

Open `http://127.0.0.1:5173`. The Vite server proxies `/api` to `http://127.0.0.1:8765`. Set `EDA_STUDIO_DEV_API_TARGET` before starting Vite to use another local API port. If the API is unavailable, the UI reports toolchain state as unknown instead of claiming each tool is unavailable.

## Build and browser smoke

```powershell
npm run build
Set-Location ../../tests/browser
npm ci
npm test -- --grep "Studio|narrow layout|unreachable local API"
```

The browser smoke stubs the API so the shell can be checked independently from machine-specific tool installation. A separate case verifies the offline/unknown state.
