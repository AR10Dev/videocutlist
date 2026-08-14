# Operations: health, upgrade, rollback, and backup

Run commands from `deployments/containers`.

## Health

```bash
docker compose ps
docker compose logs -f videocutlist
curl --fail http://127.0.0.1:8787/api/v1/health
curl --fail http://127.0.0.1:8787/api/v1/ready
```

Use `podman compose` instead of `docker compose` with Podman. The bundled
client uses the current page origin. For a separately hosted client, configure
`VIDEOCUTLIST_ALLOWED_ORIGINS` and its `window.VIDEOCUTLIST_CONFIG` as described
in the [container deployment guide](containers.md).

## Upgrade and rollback

Pull or check out the desired revision, then rebuild the image:

```bash
docker compose up -d --build
```

Compose recreates the container while retaining the `data`, `cache`, and
`exports` bind mounts. To roll back, check out the previous revision and run
the same command. Do not roll back across an unreviewed database migration.

## Backup

Stop the container before copying the database and exports for a simple
consistent backup. The preview cache is disposable.

```bash
docker compose stop
mkdir -p /var/backups/videocutlist
cp -a data/videocutlist.db exports /var/backups/videocutlist/
docker compose start
```

Back up `videocutlist.env` and original media separately. Store backups outside
the host and test restoration before relying on them.
