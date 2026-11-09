# ADR-008: Release authority and human approval

- **Status:** Accepted
- **Date:** 2026-11-09
- **Owners:** EDA Stack maintainers

## Context

Successful compilation, simulation or native export is not sufficient evidence to manufacture. Source, models, physical pin maps, requirements and evidence can change after review.

## Decision

The backend owns release eligibility and records approvals against the exact immutable revision and evidence hashes, actor, scope and timestamp. Technical findings and human physical review remain separate. AI and worker processes may propose and test but cannot approve or release. Any changed source or dependency invalidates prior approval for the new revision.

## Consequences

Release bundles remain blocked when required evidence or human review is missing, stale or mismatched. Approval history is append-only and revocation is explicit.

## Evidence and validation

S7 tests must reject unresolved ERC/DRC findings, pin/model mismatch, missing physical review and a tampered bundle hash, and must reopen an approved evidence bundle offline.
