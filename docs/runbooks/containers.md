# Container deployment

VideoCutlist supports Docker and Podman through the same Compose definition.
The image contains the Go service with the browser client embedded in its binary,
plus FFmpeg and FFprobe.

```bash
cd deployments/containers
cp videocutlist.env.example videocutlist.env
mkdir -p data cache exports
sudo chown 10001:10001 data cache exports
```

Place original media in `deployments/containers/media`, or point the bind mount
at an existing directory:

```bash
VIDEOCUTLIST_MEDIA_DIR=/srv/media docker compose up -d
# The same command works with: podman compose up -d
```

Compose uses the published `ghcr.io/ar10dev/videocutlist:latest` image by
default. Override it with `VIDEOCUTLIST_IMAGE`, for example to pin a release:

```bash
VIDEOCUTLIST_IMAGE=ghcr.io/ar10dev/videocutlist:v1.2.3 docker compose up -d
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

For a source-build fallback, the Dockerfile builds the frontend first and embeds it
in the Go binary. Build it and point Compose at the local image:

```bash
docker build -f Dockerfile -t videocutlist:local ../..
VIDEOCUTLIST_IMAGE=videocutlist:local docker compose up -d
```

Stop the service with `docker compose down` or `podman compose down`. Do not
remove the persistent directories unless the database, cache, and exports are
no longer needed.
