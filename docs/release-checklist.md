# Release candidate checklist

## Architecture

EditApp is a Go service that binds loopback by default and can use an explicit
LAN IP literal when protected by a host firewall and application authentication. It indexes
configured read-only media roots into SQLite using opaque IDs, generates
bounded on-demand fragmented-MP4 previews through FFmpeg, shares equivalent
preview work through an atomic validated cache, persists owner-scoped projects,
and creates durable stream-copy MKV exports. The React/Vite client consumes
only the frozen HTTP API and plays previews through Media Source Extensions.

```text
reachable HTTP(S) endpoint
  -> net/http API + static web
     -> auth/capabilities
     -> descriptor-safe media index -> FFprobe
     -> preview jobs -> FFmpeg -> validated atomic cache
     -> projects/export jobs -> SQLite + durable exports
```

## Repository map

```text
cmd/server/                 production composition root
internal/api,auth,httpx/    HTTP and trusted-proxy boundary
internal/media/             descriptor-safe index, probe, preview normalization
internal/jobs,cache,limits/ preview scheduling and cache publication
internal/projects,export/   persistence and durable exports
internal/store/             SQLite migrations and repositories
web/                        React/Vite client and Playwright coverage
deployments/systemd/        hardened service files
scripts/install,ops/        Arch/CachyOS install and recovery checks
test/                       fixtures, fault seams, integration, performance
docs/contracts,adr,runbooks frozen contracts and operations
```

## ADR index

- `0001`: Go/React, standard `net/http`, CGO-free SQLite.
- `0002`: original loopback identity boundary (superseded by provider-neutral runtime contracts).
- `0003`: opaque media identity and source-fingerprint cache invalidation.
- `0004`: streamed fMP4, reference-counted cancellation, validated atomic cache.

## Release gates

- [x] Go formatting and vet.
- [x] Go race, unit, and integration suites.
- [x] Web lint, unit tests, and production build.
- [x] Playwright browser workflow: list, metadata, settle, stale protection,
      playback offset, marker save, reload, and revision conflict.
- [x] Deterministic fixture, fault-cleanup, and measurement harnesses.
- [x] Live loopback smoke: index, miss/hit preview, project reload, export,
      metrics, and refresh 429 admission.
- [x] Deployment static checks and shell syntax.
- [x] Security re-review: no open critical or high findings.
- [ ] Run the installer on a disposable clean Arch/CachyOS host.

The clean-host check requires a root-managed Arch/CachyOS host unavailable in
the controller workspace. Do not promote this candidate to production until it
is checked.

## Security resolutions

- Media resolution and FFprobe share an opened descriptor beneath `os.Root`;
  symlink replacement and root replacement fail closed.
- Authentication is explicit: `none`, fixed-token `bearer`, or validated
  `trusted_proxy` identity.
- Refresh uses one global scan and a one-minute retry cooldown.
- Export capacity is acquired before SQLite persistence or goroutine creation.
- Preview replay is capped at 64 MiB; over-limit partials are discarded.
- Queued and running jobs fail safely on restart.
- State and cache recovery paths retain `root:editapp` `0770` write access.
- HTTP bodies are covered by a 15-second read timeout.

Residual policy note: `none` mode permits anonymous media metadata access. Use
`bearer` or a correctly configured `trusted_proxy` where that is unacceptable.

## Installation

```bash
sudo scripts/install/install-arch-cachyos.sh 2026-07-29
sudoedit /etc/editapp/editapp.env
sudo systemctl enable --now editapp
sudo scripts/ops/verify-deployment.sh
```

For LAN access, use a specific IP literal in `EDITAPP_LISTEN_ADDRESS`, restrict
the port with the host firewall, and configure bearer authentication. Use the
reachable HTTP(S) URL in the browser's `window.EDITAPP_CONFIG` when the client
is served from another origin.

## Known limitations

- The release implements software libx264 previews only; GPU paths are probed
  and documented but intentionally disabled.
- Export is MKV `stream_copy_preferred`; frame-accurate smart-boundary
  re-encoding is not implemented.
- Refresh is synchronous and globally serialized.
- Preview replay is bounded in memory rather than spooled per subscriber.
- The local performance sample is not an SLO and excludes tailnet latency.

## Recommended next phase

1. Validate clean-host install and LAN/reverse-proxy measurements.
2. Add reviewed VAAPI/QSV/NVENC profiles with automatic software fallback.
3. Add frame-accurate boundary re-encode and richer export progress.
4. Add a capability-gated media metadata policy if required.
5. Establish repeated performance baselines before adding regression limits.

## Review guide

Start with `cmd/server/main.go`, `docs/contracts/runtime.md`,
`internal/media/index/index.go`, `internal/jobs/preview.go`,
`internal/app/services.go`, and `web/src/App.tsx`. Key integration commits are
`b1b9323` (contracts), `d9350ba` (production wiring), `9b4173a` (bounded work),
`b64c237` (descriptor-safe media), and `44ff04d` (security gate closure).
