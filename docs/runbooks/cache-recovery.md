# Cache recovery

Preview-cache entries are disposable. At startup the service removes abandoned `.partial` files; a cache miss regenerates a valid preview and atomically publishes it only after validation.

For a targeted inspection:

```bash
sudo find /var/cache/editapp/previews -type f -name '*.partial' -ls
sudo du -sh /var/cache/editapp/previews
```

To clear only interrupted files, stop the service first so no writer races the deletion:

```bash
sudo systemctl stop editapp
sudo find /var/cache/editapp/previews -type f -name '*.partial' -delete
sudo systemctl start editapp
sudo scripts/ops/verify-deployment.sh
```

For suspected cache corruption or an urgent space recovery, move the exact cache directory aside, recreate it with the original permissions, verify the service, and delete the moved directory only after successful preview regeneration:

```bash
sudo systemctl stop editapp
sudo mv /var/cache/editapp/previews /var/cache/editapp/previews.quarantine
sudo install -d -o root -g editapp -m 0770 /var/cache/editapp/previews
sudo systemctl start editapp
sudo scripts/ops/verify-deployment.sh
```

Never expose, archive, or serve cache paths as original-media paths.
