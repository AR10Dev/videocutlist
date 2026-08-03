# Export recovery

Exports are durable outputs under `/var/lib/videocutlist/exports`; unlike previews, do not delete them as routine recovery. The service recovers interrupted durable jobs on startup, so first restart and inspect the logs:

```bash
sudo systemctl restart videocutlist
sudo journalctl -u videocutlist -n 200 --no-pager
sudo find /var/lib/videocutlist/exports -maxdepth 1 -type f -printf '%f %s bytes\n'
```

An incomplete export must not be published as success. Preserve it for diagnosis, then move only the identified file to a quarantine directory outside the export directory before retrying through the UI/API:

```bash
sudo install -d -o root -g videocutlist -m 0750 /var/lib/videocutlist/export-quarantine
sudo mv /var/lib/videocutlist/exports/IDENTIFIED-INCOMPLETE.mkv /var/lib/videocutlist/export-quarantine/
```

Check free space and writable ownership before retrying:

```bash
sudo -u videocutlist test -w /var/lib/videocutlist/exports
df -h /var/lib/videocutlist/exports
```

If the database itself needs restoration, stop the service, restore the previously tested SQLite backup with owner `root:videocutlist` and mode `0640`, then start and verify. Do not replace the database while the service is running.
