# Container deployment

This runbook describes the checked-in Compose deployment. It publishes the service on `127.0.0.1:8787` by default and persists its database, cache, and exports in separate host directories. Media is mounted read-only inside the container.

## Start with Compose

From the repository root:

```sh
cd deployments/containers
cp videocutlist.env.example videocutlist.env
mkdir -p data cache exports media
openssl rand -hex 32
```

Set `VIDEOCUTLIST_BEARER_TOKEN` in `videocutlist.env` to the generated secret. Keep that file private; it is excluded from version control. Set `VIDEOCUTLIST_MEDIA_DIR` to the host directory containing media, if it is not `./media`. Configure an appropriate media alias/path in `VIDEOCUTLIST_MEDIA_ROOTS_JSON`; the path must be the matching container path under `/srv/videocutlist/media`. The example maps the host media directory there. The listed runtime data directories must be writable by the container's unprivileged `videocutlist` user (UID 10001); adjust host ownership/permissions where required.

```sh
docker compose up -d
```

The image defaults to `ghcr.io/ar10dev/videocutlist:latest`. To build locally, run this from the repository root, then select the resulting image when starting Compose:

```sh
docker build -f deployments/containers/Dockerfile -t videocutlist:local .
cd deployments/containers
VIDEOCUTLIST_IMAGE=videocutlist:local docker compose up -d
```

The Dockerfile uses pinned Node, Go, and Debian images. The checked-in Compose deployment runs as UID 10001 with a read-only root filesystem, all Linux capabilities dropped, and privilege escalation disabled. `/tmp` is a 64 MiB tmpfs with `noexec`, `nosuid`, and `nodev`; database, preview cache, and export working files use the writable mounts above.

For rootless Podman, use `podman compose` in place of `docker compose`. Prepare the writable directories from `deployments/containers`:

```sh
podman unshare chown -R 10001:10001 data cache exports
```

Keep media readable by UID 10001; do not change source-media ownership just to run the container. For a local Podman image build, use Docker image format so Podman retains the Dockerfile's health check:

```sh
podman build --format docker -f deployments/containers/Dockerfile -t videocutlist:local .
```

Run that build command from the repository root. Podman and a Compose provider are the runtime requirements; Go, Node, pnpm, FFmpeg, FFprobe, and curl are supplied by the build/runtime images, not required on the deployment host.

Check readiness at `http://127.0.0.1:8787/ready` and health at `/health`. To use another host port, set `VIDEOCUTLIST_HOST_PORT`; to publish beyond loopback, explicitly set `VIDEOCUTLIST_BIND_ADDRESS`. Network publication beyond loopback requires deliberate firewall/access control and a protected authentication configuration. Do not select authentication mode `none` for a network-reachable deployment.

## Reverse proxies and trusted peers

Prefer keeping the container port on loopback and placing a maintained reverse proxy in front with HTTPS, authentication/access controls, and restrictive network policy. Configure forwarded-header behavior only for a proxy you control. In `trusted_proxy` mode set `VIDEOCUTLIST_TRUSTED_PROXY_CIDRS` to the proxy's exact peer addresses/CIDRs; universal `/0` networks are rejected. A matching transport peer is trusted, so any local process or container able to connect from a trusted address can authenticate. Restrict connectivity so clients cannot bypass the proxy. For bearer mode, retain the bearer secret at the proxy/application boundary and protect it from logs and source control.

MCP is off by default. If enabled, its `/mcp` endpoint has separately issued scoped credentials; it is not protected by assuming the HTTP bearer token also authenticates MCP. Avoid public exposure and create only narrowly scoped credentials.

## Data and upgrades

Persist `/var/lib/videocutlist/data`, `/var/cache/videocutlist/previews`, and `/var/lib/videocutlist/exports` as shown in Compose. The media mount is read-only. Back up the database and any exports you need before upgrading. Only the latest release is supported, and older database/configuration compatibility is not promised. Use the health/readiness endpoints after an upgrade. Do not remove application data as part of routine image updates.

The checked-in Dockerfile installs FFmpeg and FFprobe, exposes port 8787, and retains a curl-based container health check. Hardening flags are applied by Compose and the local deployment script, not by the image itself; a bare `podman run` or `docker run` must specify equivalent restrictions.

## Validate locally with Podman

From the repository root, run:

```sh
make test-podman
```

This requires rootless Podman, a working Compose provider, Node.js 22 or newer, and network access for image builds. It builds a disposable image, generates a short audio/video fixture using the image's FFmpeg, and starts the checked-in Compose configuration with isolated data and an unused loopback port. It verifies non-root execution, dropped capabilities, no-new-privileges, read-only root/media mounts, temporary-file access, authenticated media access, preview-cache misses/hits, merged and separate stream-copy/re-encoded exports, health checks, and database/cache/output persistence across restart. It removes its test deployment and data on exit; it does not restart or modify an existing deployment.

To test an already built image instead, set `VIDEOCUTLIST_TEST_IMAGE` to its tag. The smoke test requires no host Go, pnpm, FFmpeg, or FFprobe. This validation covers the included short fixture, not every codec, hardware accelerator, or host security policy.
