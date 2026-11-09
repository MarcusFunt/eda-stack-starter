# ADR-007: Local API binding and authentication

- **Status:** Accepted
- **Date:** 2026-11-09
- **Owners:** EDA Stack maintainers

## Context

Loopback services can still be targeted by malicious websites through DNS rebinding or cross-origin requests. Compile and later mutation/release operations need a capability boundary.

## Decision

Bind only `127.0.0.1`; reject non-loopback Host headers and unapproved Origins; do not enable permissive CORS. Generate a random per-process bearer token for compile and later state-changing routes, expose it through a no-store local session endpoint, and allow configured development origins only when they are loopback HTTP origins. Remote or Tailscale binding requires a separate authenticated and CSRF-protected design.

## Consequences

The S0 API is usable from a local browser and direct CLI clients while remaining intentionally inaccessible as a remote service. The session endpoint is protected by the Host/Origin policy and same-origin browser controls; XSS in the local UI remains a threat.

## Evidence and validation

API tests reject malicious Host/Origin values, missing session tokens and invalid project IDs. Future remote access requires a reviewed threat model and explicit approval flow.
