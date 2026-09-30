# Cache recovery

The cache contains disposable previews, thumbnails, and waveforms, not original
media or saved projects. The service removes abandoned `.partial` files on
startup and regenerates missing, empty, or invalid preview entries when needed.
Validation and cleanup retain files substituted at the cache path; suspicious
symlinks are not followed or removed. Stop the service and quarantine the cache
as described below if a substituted entry prevents regeneration.
Cache-hit recency updates for previews, thumbnails, and waveforms use the
validated file descriptor, so a substituted cache path cannot redirect timestamp
changes to an outside file. Platforms without descriptor-bound timestamps retain
safe cache hits without updating recency.
Rejected thumbnail and waveform entries are removed only after their current
file identity matches the inspected entry, preserving substituted files and
symlinks.

Use a separate cache directory for each service instance.

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
