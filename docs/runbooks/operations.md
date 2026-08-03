# Operations: health, smoke, upgrade, rollback, and backup

## Health and smoke

Run the read-only check after install, restart, or upgrade:

```bash
sudo scripts/ops/verify-deployment.sh
journalctl -u videocutlist -n 100 --no-pager
```

It checks `/api/v1/health`, `/api/v1/ready`, the active VideoCutlist service, and the listener configured in `/etc/videocutlist/videocutlist.env`. The server address is `http://VIDEOCUTLIST_LISTEN_ADDRESS:VIDEOCUTLIST_PORT`; bracket an IPv6 address in a browser URL.

For the bundled client served by VideoCutlist, no browser configuration is needed: it uses the current page origin and no authentication. For a separately hosted browser client, define `window.VIDEOCUTLIST_CONFIG` before its application module loads:

```html
<script>
window.VIDEOCUTLIST_CONFIG = {
  serverBaseUrl: "https://videocutlist.example.test",
  authentication: { type: "bearer", token: "editor-token" }
};
</script>
```

`serverBaseUrl` must be an absolute HTTP(S) URL without credentials, query, or fragment. Its API requests stay beneath `/api/v1/`. Set `VIDEOCUTLIST_ALLOWED_ORIGINS` to the exact client origins (comma-separated) for this cross-origin setup; a non-matching cross-origin request is denied, and `*` is never accepted. Use `{ type: "none" }` for application `none`; use `{ type: "bearer", token: "..." }` for `bearer`; use `{ type: "cookie" }` only with a trusted reverse proxy that supplies the browser session and validated `X-Forwarded-User`.

## Upgrade

Use a clean checkout at the desired revision. The release name must be new and contains only letters, digits, `.`, `_`, or `-`.

```bash
git rev-parse HEAD
sudo scripts/install/install-arch-cachyos.sh 2026-07-29.1
sudo systemctl restart videocutlist
sudo scripts/ops/verify-deployment.sh
```

The installer builds before changing `/opt/videocutlist/current`; a build failure leaves the active release untouched. Keep the prior release directory for rollback.

## Rollback

Identify a known-good release, then atomically repoint the symlink and restart:

```bash
sudo ls -1 /opt/videocutlist/releases
sudo ln -s /opt/videocutlist/releases/KNOWN_GOOD /opt/videocutlist/current.new
sudo mv -Tf /opt/videocutlist/current.new /opt/videocutlist/current
sudo systemctl restart videocutlist
sudo scripts/ops/verify-deployment.sh
```

Do not roll back the binary across an unreviewed database migration. This MVP's migrations are additive, but back up first and restore only through the tested release procedure.

## Backup

Back up configuration, SQLite, and exports. The preview cache is reproducible and excluded. Quiesce the service for a simple consistent file backup:

```bash
sudo systemctl stop videocutlist
sudo install -d -m 0700 /var/backups/videocutlist/$(date +%F)
sudo sqlite3 /var/lib/videocutlist/data/videocutlist.db ".backup '/var/backups/videocutlist/$(date +%F)/videocutlist.db'"
sudo cp -a /etc/videocutlist/videocutlist.env /var/lib/videocutlist/exports /var/backups/videocutlist/$(date +%F)/
sudo systemctl start videocutlist
sudo scripts/ops/verify-deployment.sh
```

Store backups outside the host and test restoration on a spare host before relying on them. Original media is not copied by this procedure; it needs its own storage backup and restore plan.
