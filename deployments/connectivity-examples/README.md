# Optional connectivity examples

These are optional ways to reach EditApp. The application only needs a
reachable HTTP(S) URL; ordinary IP reachability is sufficient. Choose one
approach that fits the host and network rather than combining them by default.

The default listener is loopback-only:

```text
EDITAPP_LISTEN_ADDRESS=127.0.0.1
EDITAPP_PORT=8787
```

Use an explicit IP literal only when clients must reach the server directly.
Set `EDITAPP_PUBLIC_BASE_URL` to the URL given to browsers. If the browser is
served from a different origin, set `EDITAPP_ALLOWED_ORIGINS` to that exact
origin; never use `*` with credentials.

## LAN (optional)

Bind to the host's LAN IP, not `0.0.0.0`, for example:

```text
EDITAPP_LISTEN_ADDRESS=192.0.2.10
EDITAPP_PORT=8787
EDITAPP_PUBLIC_BASE_URL=http://192.0.2.10:8787
EDITAPP_AUTH_MODE=bearer
```

Allow only the required LAN subnet and port in the host firewall. Use bearer
authentication unless the LAN itself is the complete access boundary.

## Tailscale Serve (optional)

Keep EditApp on loopback and use the [Tailscale example](tailscale/README.md)
for private HTTPS. Serve is a transport choice, not an application dependency,
and Funnel is never enabled.

## WireGuard (optional)

Keep the default loopback bind when a local reverse proxy terminates traffic,
or bind to the server's WireGuard IP when tunnel peers connect directly. Use
that reachable URL as `EDITAPP_PUBLIC_BASE_URL`; protect the tunnel endpoint
with WireGuard peer policy and application authentication as appropriate.

## SSH tunnel (optional)

Leave EditApp on loopback and forward a local browser port through SSH:

```bash
ssh -N -L 8787:127.0.0.1:8787 editor@editapp-host
```

Then use `http://127.0.0.1:8787` in the browser. SSH account access is the
network boundary; add bearer authentication when that alone is insufficient.

## Public HTTPS (optional)

Keep EditApp loopback-only and place a maintained TLS reverse proxy in front
of it. Use a public `https://` value for `EDITAPP_PUBLIC_BASE_URL`, an exact
browser origin in `EDITAPP_ALLOWED_ORIGINS` when cross-origin, and bearer or
trusted-proxy authentication. Do not expose the raw EditApp listener directly
to the public internet.

See the [generic reverse-proxy contract](../reverse-proxy/README.md) before
enabling `trusted_proxy` authentication.
