# Container deployment

VideoCutlist supports Docker and Podman through the same Compose definition.
The image contains the Go service, browser client, FFmpeg, and FFprobe.

```bash
cd deployments/containers
cp videocutlist.env.example videocutlist.env
```

Place original media in `deployments/containers/media`, or point the bind mount
at an existing directory:

```bash
VIDEOCUTLIST_MEDIA_DIR=/srv/media docker compose up -d --build
# The same command works with: podman compose up -d --build
```

Open `http://127.0.0.1:8787`. Persistent application data is stored in the
Compose directory's `data`, `cache`, and `exports` directories by default.
Override them with `VIDEOCUTLIST_DATA_DIR`, `VIDEOCUTLIST_CACHE_DIR`, and
`VIDEOCUTLIST_EXPORT_DIR`.

The default bind is loopback-only. For LAN access, set
`VIDEOCUTLIST_BIND_ADDRESS` and use `VIDEOCUTLIST_AUTH_MODE=bearer` with a
secret `VIDEOCUTLIST_BEARER_TOKEN`; restrict the published port with a firewall.

Check status and logs with either runtime:

```bash
docker compose ps
docker compose logs -f videocutlist
# podman compose ps
# podman compose logs -f videocutlist
```

Stop the service with `docker compose down` or `podman compose down`. Do not
remove the persistent directories unless the database, cache, and exports are
no longer needed.
