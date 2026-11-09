# ADR-003: Local persistence and artifact storage

- **Status:** Accepted
- **Date:** 2026-11-09
- **Owners:** EDA Stack maintainers

## Context

Projects, revisions, jobs, events, checks and approvals need crash-consistent local history. Evidence may be large and should be immutable and independently verifiable.

## Decision

Use a single local SQLite database in WAL mode for metadata and indexes, with transactional migrations and explicit single-writer rules. Store immutable artifacts by SHA-256 under a filesystem content-addressed root. Verify a temporary artifact and manifest before an atomic rename and metadata commit.

## Consequences

There is no distributed database or queue service for the offline MVP. Database backups must be coordinated with artifact-store manifests; referenced evidence cannot be silently deleted. Large files do not belong in SQLite rows.

## Evidence and validation

S1 recovery tests must cover interrupted writes, SQLite restart, corrupt temporary output, duplicate content hashes and restore from a database plus artifact backup.
