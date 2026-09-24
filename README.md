# VideoCutlist

VideoCutlist is a local-first video review tool. It indexes original media without
copying it, creates short browser previews, and exports selected segments as MKV
files. Original-media filesystem paths never leave the server.

## Features

- Read-only media indexing below configured media roots
- Ordered multi-media projects with independent edits per item
- Browser previews for selecting segments
- Stream-copy-preferred MKV batch exports
- Durable SQLite job queue with cancellation and explicit retry
- Loopback-only service by default
- Bearer and trusted-proxy authentication options
- SQLite-backed state and reproducible preview cache

## Requirements

Enter `devenv shell` for the project-local Go, gopls, golangci-lint, Node, pnpm,
FFmpeg, ShellCheck, shfmt, and Hadolint toolchain.

You still need Docker or Podman with Compose for container checks.

## Run locally

```bash
DATA_DIR="$(mktemp -d)"
# Replace /path/to/media with the local directory containing originals.
make client-install
make build
VIDEOCUTLIST_DATABASE_PATH="$DATA_DIR/videocutlist.db" \
VIDEOCUTLIST_CACHE_DIR="$DATA_DIR/cache" \
VIDEOCUTLIST_EXPORT_DIR="$DATA_DIR/exports" \
VIDEOCUTLIST_MEDIA_ROOTS_JSON='{"media":"/path/to/media"}' \
  go run ./cmd/videocutlist
```

The server listens on `127.0.0.1:8787` by default. Run it as a dedicated
non-root account with read access to the absolute media root and write access to
only the database, cache, and export directories. See the [deployment and
settings guide](docs/runbooks/containers.md) for native permissions and
container-visible mount paths. Release builds embed the bundled client in the Go
binary and serve it from the same origin. Local development builds serve the
generated `client/dist` directory.

## Deploy with Docker or Podman

The container image includes the server with the frontend embedded in its binary,
plus FFmpeg and FFprobe.
The Compose file works with either Docker Compose or Podman Compose:

```bash
cd deployments/containers
umask 077
cp videocutlist.env.example videocutlist.env
printf 'VIDEOCUTLIST_BEARER_TOKEN=%s\n' "$(openssl rand -hex 32)" >> videocutlist.env
# Put originals in ./media, or set VIDEOCUTLIST_MEDIA_DIR to another directory.
docker compose up -d
# podman compose up -d
```

Open <http://127.0.0.1:8787> and enter the generated bearer token from your private
`videocutlist.env`. The browser keeps it in memory only; reload requires sign-in
again. Never commit that file or put the token in a URL or frontend build.
The host port binding is loopback-only; the container listener requires
authentication even for local publishing. See the [container deployment
guide](docs/runbooks/containers.md) for directory permissions and remote TLS.

## MCP clients

MCP is disabled by default. Enable it in **Settings → MCP access**, create a scoped
credential, and connect a Streamable HTTP client to `http://127.0.0.1:8787/mcp`
with `Authorization: Bearer <one-time-secret>`. The pinned protocol version is
`2025-06-18`; the server returns that version during `initialize` and requires it
on subsequent session requests.

The bearer-token Streamable HTTP flow is tested with MCP Inspector. OAuth-only
clients are not supported because VideoCutlist does not provide an OAuth
authorization server or callback flow. The listener remains loopback-only by
default. A deliberately remote deployment must terminate HTTPS and retain bearer
authentication; plain HTTP is rejected for non-loopback clients.

`get_export_download` returns a protected `/mcp/download/...` URL rather than
embedding an artifact in the MCP response. Fetch it with the same bearer token;
each download rechecks the credential, scope, and revocation state.

## Development

```bash
make client-install
make check             # formatting check, lint, tests, and build
make smoke             # check plus browser tests
make test-real-media   # opt-in production process and FFmpeg verification
```

See [Contributing](CONTRIBUTING.md) before opening a pull request.

## Documentation

See the [documentation index](docs/README.md).

## Security

VideoCutlist handles paths to original media and should not be exposed directly
to the public internet. Review the [security policy](SECURITY.md) before
configuring network access.
