# ADR-002: Canonical source and immutable revisions

- **Status:** Accepted
- **Date:** 2026-11-09
- **Owners:** EDA Stack maintainers

## Context

Studio needs editor state, compiled output and engineering evidence without silently changing the existing compiler contract or making generated files authoritative.

## Decision

Keep TSX and reviewed project configuration (`eda.project.json`, requirements, parts lock, PCB constraints and reviewed models) as canonical source. Store UI/workspace preferences separately. A frozen revision records a complete source/configuration hash, parent, toolchain profile and timestamp; later edits create a new draft. Circuit JSON, SPICE, KiCad and previews are immutable derived artifacts.

## Consequences

Existing project schemas remain compatible and imported projects can be shown without rewriting them. The workspace must maintain an explicit mapping between draft files and frozen snapshots; this metadata may need migration if the compiler contract later absorbs Studio fields.

## Evidence and validation

S1 tests must prove freeze/reopen hash stability, optimistic revision conflicts and that draft edits cannot change an earlier frozen tree.
