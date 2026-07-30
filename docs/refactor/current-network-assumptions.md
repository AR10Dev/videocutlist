# Current Network Assumptions

## Listener and process

- `internal/config/config.go` defaults `EDITAPP_LISTEN_ADDR` to
  `127.0.0.1:8787`; `validateListenAddr` rejects every non-loopback host.
- `cmd/server/main.go` passes that value to `http.Server.Addr`, logs it as
  `server_started.listen_addr`, and hard-codes 5 s header, 15 s read, and 60 s
  idle timeouts. Write timeout is not configured.
- Systemd environment, scripts, and runbooks assert literal loopback `:8787`.

## Authentication and proxy trust

- Default mode is `tailscale`; only `tailscale` and `dev` are valid.
- Production accepts `Tailscale-User-Login` and optional
  `Tailscale-App-Capabilities` only when immediate `RemoteAddr` is in
  `EDITAPP_TRUSTED_PROXY_CIDRS`, default `127.0.0.0/8,::1/128`.
- No generic `Forwarded`, `X-Forwarded-*`, or `X-Real-IP` handling exists.
- Development synthesizes `EDITAPP_DEV_USER_LOGIN` only for loopback peers.
  Project ownership uses normalized provider login.

## Client API and origin

- `web/src/App.tsx` declares `const api = "/api/v1"`; every media, preview,
  project, and export request is relative to it.
- `web/src/preview.ts` receives that URL and fetches directly; it has no
  configuration or authentication boundary.
- UI and API therefore require one origin. There is no base URL, bearer/cookie
  selection, URL normalization, or CORS implementation.
- `web/playwright.config.ts` runs `http://127.0.0.1:5173`; route interception
  in `segment-selection.spec.ts` matches `**/api/v1/**`.

## Health, deployment, and test posture

- `/api/v1/health` and `/api/v1/ready` are checked at loopback `:8787`.
- The setup script requires local service health, configures Serve HTTPS 443,
  and invokes the deployment verifier. The installer installs/enables provider
  software; operations directs users to a tailnet HTTPS hostname.
- Config tests assert loopback and the `tailscale` default; API tests exercise
  only the provider-header spoofing path. No test covers generic forwarded
  headers, CORS, separate origins, or LAN binding.

## Security constraints to preserve

The loopback-only rule prevents direct header spoofing but blocks LAN/public/
reverse-proxy deployment. Stages 1, 3, and 4 must replace it with explicit
binding, exact-origin CORS, and trusted-immediate-peer rules. Media-ID path
containment, FFmpeg argument arrays, cancellation, atomic publication, and
the Funnel prohibition are independent of transport choice.
