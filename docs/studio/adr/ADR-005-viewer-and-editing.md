# ADR-005: Viewer and source-editing strategy

- **Status:** Accepted
- **Date:** 2026-11-09
- **Owners:** EDA Stack maintainers

## Context

The MVP needs useful schematic inspection without reimplementing KiCad's schematic and PCB editing capabilities. Circuit JSON already has a canonical source graph, but identity coverage must remain explicit.

## Decision

Use Circuit JSON and the canonical source graph as the first read-only viewer input. Keep source editing in TSX and use only typed, reviewable source modifications for supported property edits. Treat native KiCad output as a derived preview/handoff; unknown mappings remain unresolved rather than guessed.

## Consequences

The MVP can ship selection, net inspection and cross-probing without a graphical wiring editor. Unsupported objects may require opening KiCad or the source editor; identity coverage must be measured per converter/runtime version.

## Evidence and validation

S2 tests use the RC, two-resistor-label, power-rail, LED/transistor, LDO/sensor and malformed-TSX fixtures, and report unmapped objects explicitly.
