# Install on Arch/CachyOS

Run this on the host holding the original media. The installer uses Arch packages, builds the checked-out Go and web sources, installs an immutable release under `/opt/editapp/releases`, and atomically repoints `/opt/editapp/current`. It does not start the service or configure public access.

```bash
sudo scripts/install/install-arch-cachyos.sh 2026-07-29
sudoedit /etc/editapp/editapp.env
sudo systemctl enable --now tailscaled editapp
sudo scripts/ops/setup-tailscale-serve.sh
```

Set `EDITAPP_MEDIA_ROOTS_JSON` to a mounted originals directory before starting. The default path is `/srv/editapp/media`; mount or bind-mount originals there rather than copying them into application state.

| Path or identity | Owner and mode | Purpose |
| --- | --- | --- |
| `editapp` | system user, no login shell | service identity |
| `editapp-media` | system group | read/traverse access to original-media mount only |
| `/srv/editapp/media` | `root:editapp-media`, `0750` | read-only original-media mount point |
| `/var/lib/editapp/data` | `root:editapp`, `0750` | SQLite database |
| `/var/cache/editapp/previews` | `root:editapp`, `0750` | disposable preview cache |
| `/var/lib/editapp/exports` | `root:editapp`, `0750` | completed and temporary exports |
| `/etc/editapp/editapp.env` | `root:editapp`, `0640` | production configuration |

The systemd sandbox permits writes only to the database, cache, and export paths and mounts media read-only. Do not make originals writable by `editapp`. Keep `EDITAPP_LISTEN_ADDR=127.0.0.1:8787`; the server refuses a non-loopback address.

After changing the environment file, run `sudo systemctl restart editapp` and `sudo scripts/ops/verify-deployment.sh`.
