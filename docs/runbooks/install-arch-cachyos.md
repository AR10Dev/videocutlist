# Install on Arch/CachyOS

Run this on the host holding the original media. The installer uses Arch packages, builds the checked-out Go and `client` sources, installs an immutable release under `/opt/editapp/releases`, and atomically repoints `/opt/editapp/current`. It does not start the service or configure connectivity.

```bash
sudo scripts/install/install-arch-cachyos.sh 2026-07-29
sudoedit /etc/editapp/editapp.env
sudo systemctl enable --now editapp
sudo scripts/ops/verify-deployment.sh
```

Set `EDITAPP_MEDIA_ROOTS_JSON` to a mounted originals directory before starting. The default path is `/srv/editapp/media`; mount or bind-mount originals there rather than copying them into application state. The default listener is `127.0.0.1:8787`; open `http://127.0.0.1:8787` from the host browser.

For a LAN deployment, set `EDITAPP_LISTEN_ADDRESS` to the host's specific LAN IP literal (not a hostname) and leave `EDITAPP_PORT=8787` or choose another valid port. Restrict that port in the host firewall to intended clients and use `EDITAPP_AUTH_MODE=bearer` with a non-empty `EDITAPP_BEARER_TOKEN`; `none` is suitable only for a trusted local network. Restart EditApp, verify it, then open `http://LAN_IP:8787` from a client.

If the browser client is hosted at another origin, set `EDITAPP_ALLOWED_ORIGINS` to its exact comma-separated HTTP(S) origins, for example `https://editor.example.test`; wildcards and paths are rejected. The browser page must define `window.EDITAPP_CONFIG` before the application module loads:

```html
<script>
window.EDITAPP_CONFIG = {
  serverBaseUrl: "http://LAN_IP:8787",
  authentication: { type: "bearer", token: "the-same-bearer-token" }
};
</script>
```

Use `{ type: "none" }` for `EDITAPP_AUTH_MODE=none`. For `trusted_proxy`, use `{ type: "cookie" }` only when a trusted reverse proxy supplies the authenticated browser session and reaches EditApp from a CIDR in `EDITAPP_TRUSTED_PROXY_CIDRS`; it must set `X-Forwarded-User`. Do not put a bearer token in a build-time frontend environment variable or a public static page.

| Path or identity | Owner and mode | Purpose |
| --- | --- | --- |
| `editapp` | system user, no login shell | service identity |
| `editapp-media` | system group | read/traverse access to original-media mount only |
| `/srv/editapp/media` | `root:editapp-media`, `0750` | read-only original-media mount point |
| `/var/lib/editapp/data` | `root:editapp`, `0770` | writable SQLite database |
| `/var/cache/editapp/previews` | `root:editapp`, `0770` | writable disposable preview cache |
| `/var/lib/editapp/exports` | `root:editapp`, `0770` | writable completed and temporary exports |
| `/etc/editapp/editapp.env` | `root:editapp`, `0640` | production configuration |

The systemd sandbox permits writes only to the database, cache, and export paths and mounts media read-only. Do not make originals writable by `editapp`. Keep the default loopback listener unless you have deliberately configured a firewall-protected LAN address.

After changing the environment file, run `sudo systemctl restart editapp` and `sudo scripts/ops/verify-deployment.sh`.

Optional private-network and public-HTTPS examples are separate from this
primary systemd flow; see [connectivity examples](../../deployments/connectivity-examples/README.md).
