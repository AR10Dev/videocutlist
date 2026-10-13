# VideoCutList

VideoCutList is a self-hosted web application for organizing video media, reviewing clips, and preparing exports. It scans configured media roots and uses FFmpeg/FFprobe for media operations.

## Quick start (local source)

Requirements: Go 1.26 or newer, Node.js 26.7.0, pnpm 10.34.5, FFmpeg, and FFprobe. From the repository root, install and build the frontend before starting the server:

```sh
pnpm --dir web install --frozen-lockfile
pnpm --dir web run build

work=$(mktemp -d)
port=8787
mkdir -p "$work"/{media,cache,exports}
VIDEOCUTLIST_DATABASE_PATH="$work/videocutlist.db" \
VIDEOCUTLIST_CACHE_DIR="$work/cache" \
VIDEOCUTLIST_EXPORT_DIR="$work/exports" \
VIDEOCUTLIST_MEDIA_ROOTS_JSON="{}" \
VIDEOCUTLIST_PORT="$port" \
go run ./cmd/videocutlist
```

Open <http://127.0.0.1:8787>. Stop with Ctrl-C. To browse media, set `VIDEOCUTLIST_MEDIA_ROOTS_JSON` to a JSON object mapping a safe alias to an existing directory, for example `{"media":"/absolute/path/to/videos"}`. Keep originals outside application-managed cache and export directories. The process defaults to loopback and authentication mode `none`; do not expose that configuration to a network.

The default FFmpeg and FFprobe executable names are `ffmpeg` and `ffprobe`; set `VIDEOCUTLIST_FFMPEG_PATH` and `VIDEOCUTLIST_FFPROBE_PATH` when needed. The `make run` development target uses `.cache/videocutlist` for application data.

## Configuration and deployment

The server reads `VIDEOCUTLIST_*` environment variables. Database, cache, and export paths are required. See [`deployments/containers/videocutlist.env.example`](deployments/containers/videocutlist.env.example) for container defaults and authentication examples, and the [container runbook](docs/runbooks/containers.md) for Compose setup, storage, proxy, and exposure guidance.

Authentication modes are `none`, `bearer`, and `trusted_proxy`. `none` is restricted to a loopback listener. Bearer mode requires a control-free token of at least 32 bytes; generate one with `openssl rand -hex 32` and store it as a secret. Trusted-proxy mode requires explicit trusted peer CIDRs. Only use it when the server is reachable solely through those proxy peers; forwarded client-address headers are not a substitute for network isolation. Review allowed origins and public-base-URL settings when deploying behind a reverse proxy.

MCP is disabled by default. Enabling it exposes the `/mcp` endpoint; create scoped MCP credentials through application settings and grant only required permissions/media/project scope. MCP credentials are separate from HTTP bearer authentication. Do not expose MCP to untrusted networks.

## Support and development

The project supports the latest release. It supports the current design only; backward compatibility with older databases or configurations is not promised. Back up application data before upgrades. To run the project checks, see `make check`; `make smoke` also runs browser end-to-end tests.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and [LICENSE](LICENSE) for license terms.
