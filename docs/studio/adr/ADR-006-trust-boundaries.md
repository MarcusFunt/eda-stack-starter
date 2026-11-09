# ADR-006: Trust boundaries for projects and workers

- **Status:** Accepted
- **Date:** 2026-11-09
- **Owners:** EDA Stack maintainers

## Context

Imported projects, TSX, models, netlists, KiCad files, reports and AI output are untrusted. The host API and browser must not become a path or shell execution service.

## Decision

Validate project IDs and source trees server-side, pass only a project folder under an explicitly configured workspace to the existing adapter, and keep compiler execution inside the pinned, bounded, network-disabled worker. Invoke tools with argument arrays and never accept an arbitrary executable, source path or output path from HTTP input. Verify output schemas and hashes before returning artifact references.

## Consequences

The worker remains the authoritative compiler boundary; the API's health/toolchain display is advisory. Projects containing unsupported links, files or dependencies fail closed. SVG and logs require safe rendering before UI integration.

## Evidence and validation

Keep workspace-escape, malformed-source, sandbox timeout/kill, stale-manifest, symlink and artifact-tamper tests in the acceptance matrix.
