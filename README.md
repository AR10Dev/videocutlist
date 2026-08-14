# VideoCutlist

VideoCutlist is a local-first video review tool. It indexes original media without
copying it, creates short browser previews, and exports selected segments as MKV
files. Original-media filesystem paths never leave the server.

## Features

- Read-only media indexing below configured media roots
- Browser previews for selecting segments
- Stream-copy-preferred MKV exports
- Loopback-only service by default
- Bearer and trusted-proxy authentication options
- SQLite-backed state and reproducible preview cache

## Requirements

- Go 1.26+
- Node.js 26+
- pnpm 10.34.5+
- FFmpeg and FFprobe
- Docker or Podman with Compose

## Run locally

```bash
cp deployments/systemd/videocutlist.env.example /tmp/videocutlist.env
# Edit VIDEOCUTLIST_MEDIA_ROOTS_JSON in /tmp/videocutlist.env.
make client-install
make build
VIDEOCUTLIST_MEDIA_ROOTS_JSON='[{"id":"media","path":"/path/to/media"}]' \
  go run ./cmd/server
```

The server listens on `127.0.0.1:8787` by default. The bundled client is served
from the same origin.

## Deploy with Docker or Podman

The container image includes the server, bundled client, FFmpeg, and FFprobe.
The Compose file works with either Docker Compose or Podman Compose:

```bash
cd deployments/containers
cp videocutlist.env.example videocutlist.env
# Put originals in ./media, or set VIDEOCUTLIST_MEDIA_DIR to another directory.
docker compose up -d --build
# podman compose up -d --build
```

Open <http://127.0.0.1:8787>. The default port binding is loopback-only; set
`VIDEOCUTLIST_BIND_ADDRESS=0.0.0.0` only with authentication and a firewall.
See the [container deployment guide](docs/runbooks/containers.md).

## Development

```bash
make client-install
make check       # format, lint, tests, and build
make smoke       # check plus architecture, deployment, and browser checks
```

See [Contributing](CONTRIBUTING.md) before opening a pull request.

## Documentation

- [Documentation index](docs/README.md)
- [Container deployment](docs/runbooks/containers.md)
- [Operations, upgrades, rollback, and backup](docs/runbooks/operations.md)
- [Connectivity examples](deployments/connectivity-examples/README.md)
- [API contract](docs/contracts/api.openapi.yaml)
- [Runtime contract](docs/contracts/runtime.md)

## Security

VideoCutlist handles paths to original media and should not be exposed directly
to the public internet. Review the [security policy](SECURITY.md) before
configuring network access.
