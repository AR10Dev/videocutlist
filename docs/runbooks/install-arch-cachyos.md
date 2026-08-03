# Install on Arch/CachyOS

Run this on the host holding the original media. The installer uses Arch packages, builds the checked-out Go and `client` sources, installs an immutable release under `/opt/videocutlist/releases`, and atomically repoints `/opt/videocutlist/current`. It does not start the service or configure connectivity.

```bash
sudo scripts/install/install-arch-cachyos.sh 2026-07-29
sudoedit /etc/videocutlist/videocutlist.env
sudo systemctl enable --now videocutlist
sudo scripts/ops/verify-deployment.sh
```

Set `VIDEOCUTLIST_MEDIA_ROOTS_JSON` to a mounted originals directory before starting. The default path is `/srv/videocutlist/media`; mount or bind-mount originals there rather than copying them into application state. The default listener is `127.0.0.1:8787`; open `http://127.0.0.1:8787` from the host browser.

For a LAN deployment, set `VIDEOCUTLIST_LISTEN_ADDRESS` to the host's specific LAN IP literal (not a hostname) and leave `VIDEOCUTLIST_PORT=8787` or choose another valid port. Restrict that port in the host firewall to intended clients and use `VIDEOCUTLIST_AUTH_MODE=bearer` with a non-empty `VIDEOCUTLIST_BEARER_TOKEN`; `none` is suitable only for a trusted local network. Restart VideoCutlist, verify it, then open `http://LAN_IP:8787` from a client.

If the browser client is hosted at another origin, set `VIDEOCUTLIST_ALLOWED_ORIGINS` to its exact comma-separated HTTP(S) origins, for example `https://editor.example.test`; wildcards and paths are rejected. The browser page must define `window.VIDEOCUTLIST_CONFIG` before the application module loads:

```html
<script>
window.VIDEOCUTLIST_CONFIG = {
  serverBaseUrl: "http://LAN_IP:8787",
  authentication: { type: "bearer", token: "the-same-bearer-token" }
};
</script>
```

Use `{ type: "none" }` for `VIDEOCUTLIST_AUTH_MODE=none`. For `trusted_proxy`, use `{ type: "cookie" }` only when a trusted reverse proxy supplies the authenticated browser session and reaches VideoCutlist from a CIDR in `VIDEOCUTLIST_TRUSTED_PROXY_CIDRS`; it must set `X-Forwarded-User`. Do not put a bearer token in a build-time frontend environment variable or a public static page.

| Path or identity | Owner and mode | Purpose |
| --- | --- | --- |
| `videocutlist` | system user, no login shell | service identity |
| `videocutlist-media` | system group | read/traverse access to original-media mount only |
| `/srv/videocutlist/media` | `root:videocutlist-media`, `0750` | read-only original-media mount point |
| `/var/lib/videocutlist/data` | `root:videocutlist`, `0770` | writable SQLite database |
| `/var/cache/videocutlist/previews` | `root:videocutlist`, `0770` | writable disposable preview cache |
| `/var/lib/videocutlist/exports` | `root:videocutlist`, `0770` | writable completed and temporary exports |
| `/etc/videocutlist/videocutlist.env` | `root:videocutlist`, `0640` | production configuration |

The systemd sandbox permits writes only to the database, cache, and export paths and mounts media read-only. Do not make originals writable by `videocutlist`. Keep the default loopback listener unless you have deliberately configured a firewall-protected LAN address.

After changing the environment file, run `sudo systemctl restart videocutlist` and `sudo scripts/ops/verify-deployment.sh`.

Optional private-network and public-HTTPS examples are separate from this
primary systemd flow; see [connectivity examples](../../deployments/connectivity-examples/README.md).
