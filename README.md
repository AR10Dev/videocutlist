# EditApp

EditApp indexes read-only original media, creates short browser previews, and
creates stream-copy-preferred MKV exports. Original-media paths are never sent
to the browser.

## Start

On the media host, install and configure EditApp:

```bash
sudo scripts/install/install-arch-cachyos.sh 2026-07-29
sudoedit /etc/editapp/editapp.env
sudo systemctl enable --now editapp
sudo scripts/ops/verify-deployment.sh
```

Set `EDITAPP_MEDIA_ROOTS_JSON` before starting. The default listener is
`127.0.0.1:8787`, so open `http://127.0.0.1:8787` from that host. The bundled
browser client uses the current page origin and `{ type: "none" }` by default.

For LAN access, set `EDITAPP_LISTEN_ADDRESS` to the host's specific LAN IP
literal and restart the service. Restrict the chosen `EDITAPP_PORT` in the host
firewall, use `EDITAPP_AUTH_MODE=bearer` with a non-empty
`EDITAPP_BEARER_TOKEN`, then open `http://LAN_IP:PORT` from an allowed client.

## Separate browser client

When the browser is served from a different origin, set
`EDITAPP_ALLOWED_ORIGINS` to the exact comma-separated client origins. It is
deny-by-default; wildcards and paths are not valid. Define this before the app
module runs:

```html
<script>
window.EDITAPP_CONFIG = {
  serverBaseUrl: "https://editapp.example.test",
  authentication: { type: "bearer", token: "editor-token" }
};
</script>
```

`serverBaseUrl` is an absolute HTTP(S) URL without credentials, query, or
fragment; requests resolve below `/api/v1/`. Set authentication to
`{ type: "none" }` for `EDITAPP_AUTH_MODE=none`. Use `{ type: "cookie" }`
only when a trusted reverse proxy supplies the browser session and the service
accepts that proxy through `EDITAPP_TRUSTED_PROXY_CIDRS`.

Do not place bearer tokens in build-time frontend environment variables or a
public static page. See [installation](docs/runbooks/install-arch-cachyos.md)
and [operations](docs/runbooks/operations.md) for the filesystem, rollback,
backup, and health-check procedures.
