# Cache recovery

Preview-cache entries are disposable. At startup the service removes abandoned `.partial` files; a cache miss regenerates a valid preview and atomically publishes it only after validation.

For a targeted inspection:

```bash
sudo find /var/cache/videocutlist/previews -type f -name '*.partial' -ls
sudo du -sh /var/cache/videocutlist/previews
```

To clear only interrupted files, stop the service first so no writer races the deletion:

```bash
sudo systemctl stop videocutlist
sudo find /var/cache/videocutlist/previews -type f -name '*.partial' -delete
sudo systemctl start videocutlist
sudo scripts/ops/verify-deployment.sh
```

For suspected cache corruption or an urgent space recovery, move the exact cache directory aside, recreate it with the original permissions, verify the service, and delete the moved directory only after successful preview regeneration:

```bash
sudo systemctl stop videocutlist
sudo mv /var/cache/videocutlist/previews /var/cache/videocutlist/previews.quarantine
sudo install -d -o root -g videocutlist -m 0770 /var/cache/videocutlist/previews
sudo systemctl start videocutlist
sudo scripts/ops/verify-deployment.sh
```

Never expose, archive, or serve cache paths as original-media paths.
