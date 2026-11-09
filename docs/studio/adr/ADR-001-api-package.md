# ADR-001: API package and execution model

- **Status:** Accepted
- **Date:** 2026-11-09
- **Owners:** EDA Stack maintainers

## Context

Studio must reuse the existing Python verifier and tscircuit build adapter without creating duplicate domain logic. A new standalone Python package would add another packaging and dependency boundary before the first workflow exists.

## Decision

Place the FastAPI application under `src/edastack/studio` in the existing package. Run one local Uvicorn process bound to `127.0.0.1`. Keep build invocation behind the existing `edastack.adapters.tscircuit` function. The synchronous compile route is an S0 integration spike; S1 replaces it with durable jobs.

## Consequences

The first API can reuse project validators and the existing adapter directly. Studio remains coupled to the `edastack` release; extraction into a separately deployed service will require a package boundary and API adapter migration.

## Evidence and validation

API tests exercise the route contracts and a real voltage-divider fixture compiles through the worker. The current runtime uses FastAPI 0.162.2 and Uvicorn 0.54.0, pinned in project metadata.
