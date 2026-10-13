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

The image defaults to `ghcr.io/ar10dev/videocutlist:latest`. To build locally, run `docker compose build` (or build the Dockerfile from the repository root) and configure Compose to use that image. The Dockerfile uses pinned Node, Go, and Debian images; build support with local Podman has not been validated and is a known limitation. The checked-in container does run as a non-root user. Do not assume additional runtime restrictions such as a read-only root filesystem are enabled.

Check readiness at `http://127.0.0.1:8787/ready` and health at `/health`. To use another host port, set `VIDEOCUTLIST_HOST_PORT`; to publish beyond loopback, explicitly set `VIDEOCUTLIST_BIND_ADDRESS`. Network publication beyond loopback requires deliberate firewall/access control and a protected authentication configuration. Do not select authentication mode `none` for a network-reachable deployment.

## Reverse proxies and trusted peers

Prefer keeping the container port on loopback and placing a maintained reverse proxy in front with HTTPS, authentication/access controls, and restrictive network policy. Configure forwarded-header behavior only for a proxy you control. In `trusted_proxy` mode set `VIDEOCUTLIST_TRUSTED_PROXY_CIDRS` to the proxy's exact peer addresses/CIDRs; universal `/0` networks are rejected. A matching transport peer is trusted, so any local process or container able to connect from a trusted address can authenticate. Restrict connectivity so clients cannot bypass the proxy. For bearer mode, retain the bearer secret at the proxy/application boundary and protect it from logs and source control.

MCP is off by default. If enabled, its `/mcp` endpoint has separately issued scoped credentials; it is not protected by assuming the HTTP bearer token also authenticates MCP. Avoid public exposure and create only narrowly scoped credentials.

## Data and upgrades

Persist `/var/lib/videocutlist/data`, `/var/cache/videocutlist/previews`, and `/var/lib/videocutlist/exports` as shown in Compose. The media mount is read-only. Back up the database and any exports you need before upgrading. Only the latest release is supported, and older database/configuration compatibility is not promised. Use the health/readiness endpoints after an upgrade. Do not remove application data as part of routine image updates.

The checked-in Dockerfile installs FFmpeg and FFprobe, exposes port 8787, and uses a curl-based container health check. The committed image configuration does not declare a read-only root filesystem or drop capabilities/no-new-privileges; do not treat those as tested deployment properties.
