# Cache recovery

Preview-cache entries are disposable. At startup the service removes abandoned
`.partial` files; a cache miss regenerates a valid preview and publishes it only
after validation.

Run from `deployments/containers`:

```bash
docker compose stop
find cache -type f -name '*.partial' -delete
docker compose start
```

For urgent space recovery, stop the service, move `cache` aside, recreate it,
and start the service again:

```bash
docker compose stop
mv cache cache.quarantine
mkdir cache
docker compose start
```

Delete the quarantine only after successful preview regeneration. Never expose,
archive, or serve cache paths as original-media paths. Use `podman compose`
instead of `docker compose` with Podman.
