# ADR: Connectivity Provider Independence

Status: accepted

## Context

The Stage 0 audit found provider-shaped listener validation, authentication
naming, API assumptions, installation, health checks, and runbooks. EditApp
must work over any reachable standard IP network while retaining its media and
process-security controls.

## Decision

Treat Tailscale, WireGuard, LAN routing, public HTTPS, SSH tunnels, and
reverse proxies as optional connectivity mechanisms outside the core
application. Core traffic remains HTTP(S), streamed HTTP previews, and JSON.
Generic proxy trust and authentication are explicit application boundaries;
provider adapters may exist outside core packages.

Tailscale remains an optional deployment example. Funnel remains forbidden in
that example because it is public exposure, not a core requirement.

## Consequences and deferral

The server keeps a safe loopback default and supports explicit LAN or
reverse-proxy deployment. The browser has an explicit base URL. Provider
identity is never trusted merely because a header exists. Media-ID containment,
FFmpeg execution, cancellation, cache, project, and export guarantees remain.
See [architecture](../architecture.md) for the enforced classification rule.
