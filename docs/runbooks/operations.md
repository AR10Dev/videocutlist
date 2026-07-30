# Operations: health, smoke, upgrade, rollback, and backup

## Health and smoke

Run the read-only check after install, restart, upgrade, or Serve changes:

```bash
sudo scripts/ops/verify-deployment.sh
journalctl -u editapp -n 100 --no-pager
```

It checks `/api/v1/health`, `/api/v1/ready`, the loopback-only listener, active services, the Serve target, and absence of Funnel. A tailnet client should load the HTTPS Serve hostname, not port 8787 or a LAN address.

## Upgrade

Use a clean checkout at the desired revision. The release name must be new and contains only letters, digits, `.`, `_`, or `-`.

```bash
git rev-parse HEAD
sudo scripts/install/install-arch-cachyos.sh 2026-07-29.1
sudo systemctl restart editapp
sudo scripts/ops/verify-deployment.sh
```

The installer builds before changing `/opt/editapp/current`; a build failure leaves the active release untouched. Keep the prior release directory for rollback.

## Rollback

Identify a known-good release, then atomically repoint the symlink and restart:

```bash
sudo ls -1 /opt/editapp/releases
sudo ln -s /opt/editapp/releases/KNOWN_GOOD /opt/editapp/current.new
sudo mv -Tf /opt/editapp/current.new /opt/editapp/current
sudo systemctl restart editapp
sudo scripts/ops/verify-deployment.sh
```

Do not roll back the binary across an unreviewed database migration. This MVP's migrations are additive, but back up first and restore only through the tested release procedure.

## Backup

Back up configuration, SQLite, and exports. The preview cache is reproducible and excluded. Quiesce the service for a simple consistent file backup:

```bash
sudo systemctl stop editapp
sudo install -d -m 0700 /var/backups/editapp/$(date +%F)
sudo sqlite3 /var/lib/editapp/data/editapp.db ".backup '/var/backups/editapp/$(date +%F)/editapp.db'"
sudo cp -a /etc/editapp/editapp.env /var/lib/editapp/exports /var/backups/editapp/$(date +%F)/
sudo systemctl start editapp
sudo scripts/ops/verify-deployment.sh
```

Store backups outside the host and test restoration on a spare host before relying on them. Original media is not copied by this procedure; it needs its own storage backup and restore plan.
