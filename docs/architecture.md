# Architecture

## Outcome

The Stage 0 audit found provider-shaped listener, identity, installation,
verification, runbook, and browser-path assumptions. The completed refactor
keeps EditApp provider-neutral: localhost/LAN systemd deployment is primary;
connectivity products are optional deployment examples only.

## Data flow

`cmd/server` loads configuration, opens SQLite, recovers interrupted jobs,
resolves configured media roots, constructs adapters, and serves `client/dist`.
The browser reads optional `window.EDITAPP_CONFIG`, then requests only the
normalized `/api/v1/` HTTP boundary. CORS first permits exact configured
origins; trusted-proxy middleware then validates only configured immediate
peers and strips untrusted forwarded headers; authentication produces a
provider-neutral principal before application services run.

Media IDs resolve beneath canonical configured roots and never reveal original
paths. Preview requests normalize windows, deduplicate equivalent work, stream
FFmpeg output as it arrives, and cancel the shared process when no subscribers
remain. Completed previews pass FFprobe validation and publish from a partial
file by atomic rename. Projects and export jobs persist in SQLite; exports
write temporary output, validate it, and atomically publish it. Stream-copy
exports are preferred, not frame-exact away from keyframes.

## Boundaries

| Area | Responsibility and allowed dependencies |
| --- | --- |
| `domain/` | Pure business values and rules; no other `editapp` package, `net/http`, `database/sql`, or `os/exec`. |
| `application/` | Use cases over domain contracts; may import `editapp/domain` only and never `net/http`. |
| `protocol/` | HTTP request/response, authentication, CORS, and proxy trust; may call application/domain, never infrastructure. |
| `infrastructure/` | SQLite, filesystem, FFmpeg/FFprobe, cache, media, and adapter implementations; never protocol. |
| `cmd/server/` | Composition root only. |
| `client/src/` | Browser UI and HTTP client; no connectivity-product coupling. |
| `deployments/` | systemd primary deployment, generic proxy guidance, and optional connectivity tooling. |

The refactor order was configuration, client base URL, CORS/proxy trust,
provider-neutral principal authentication, streaming/cache regression coverage,
then deployment separation. The resulting contracts preserve loopback defaults,
explicit LAN binding, authentication, and exact-origin CORS without a provider
runtime dependency.

## Provider classification

Provider terms are forbidden from production core (`domain`, `application`,
`protocol`, `infrastructure`, `cmd`, and `client/src`) and primary installation
or runtime operations. They are allowed only in optional connectivity
documentation/tooling under `deployments/connectivity-examples/`, this
classification, the connectivity ADR, explicit spoofing fixtures, and checks
that enforce this rule. Optional examples must not modify the application
binary. Funnel is never enabled or recommended; a read-only status check is
permitted to reject an already-enabled Funnel.
