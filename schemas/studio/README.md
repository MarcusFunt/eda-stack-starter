# Studio contract schemas

The versioned S0 API contract lives in `v1/`. `openapi.json` is generated from `edastack.studio.api.create_app().openapi()` and is checked against the runtime document by `tests/test_studio_contracts.py`. The example payloads are literal fixtures validated against the OpenAPI component schemas. `statuses.json` keeps check dispositions, job states and revision lifecycle values distinct.

When a contract changes, regenerate the OpenAPI snapshot with the pinned development environment, update only the affected fixtures, and run `python -m pytest tests/test_studio_contracts.py tests/test_studio_api.py`.
