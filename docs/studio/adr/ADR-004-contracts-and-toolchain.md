# ADR-004: Versioned contracts and toolchain fingerprints

- **Status:** Accepted
- **Date:** 2026-11-09
- **Owners:** EDA Stack maintainers

## Context

Python services and a TypeScript client must agree on API payloads and distinguish absent, failed and unsupported evidence. Toolchain drift can invalidate old results.

## Decision

Prefix routes with `/api/v1`, include `schema_version: 1` in persisted/public payloads, and publish the FastAPI-generated OpenAPI document. Keep shared JSON Schema fixtures under `schemas/studio/v1`; generate TypeScript types from OpenAPI in S1. Record exact compiler lock and image hashes, worker/tool versions and engine availability with build evidence.

## Consequences

Changing a payload incompatibly requires a versioned migration. Toolchain availability is reported separately from a successful compile, and each worker build independently verifies the pinned image.

## Evidence and validation

Contract tests compare the runtime OpenAPI document to the committed snapshot and validate versioned fixtures. Toolchain tests prove missing tools and stale sandbox images cannot be reported available.
