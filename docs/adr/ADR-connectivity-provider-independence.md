# ADR: Connectivity Provider Independence

Status: accepted for staged refactor

## Context

The current application couples listener validation, authentication naming,
API assumptions, installation, health checks, and primary runbooks to
Tailscale Serve. It must work over any reachable standard IP network while
retaining its media and process-security controls.

## Decision

Treat Tailscale, WireGuard, LAN routing, public HTTPS, SSH tunnels, and
reverse proxies as optional connectivity mechanisms outside the core
application. Core traffic remains HTTP(S), streamed HTTP previews, and JSON.
Generic proxy trust and authentication are explicit application boundaries;
provider adapters may exist outside core packages.

Tailscale remains an optional deployment example. Funnel remains forbidden in
that example because it is public exposure, not a core requirement.

## Consequences and deferral

The server keeps a safe loopback default but may later support explicit LAN or
reverse-proxy binding. The browser later receives an explicit base URL. Provider
identity is never trusted merely because a header exists. Media-ID containment,
FFmpeg execution, cancellation, cache, project, and export guarantees remain.

This ADR authorizes no runtime, contract, deployment, or feature change in
Stage 0. The controller must freeze replacements for runtime, OpenAPI,
project-owner, configuration, and identity contracts before implementation.
