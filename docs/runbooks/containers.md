# Deployment and settings guide

VideoCutlist has three configuration scopes:

- **Deployment configuration** comes from the process environment and Compose.
  It includes the listener, authentication, proxy/CORS policy, database/cache/
  export locations, media-root paths, destination paths, and container mounts.
- **Runtime settings** are shared settings stored in SQLite: safe destination
  labels/retention, preview/export limits, and scan/cache policy. Existing saved
  values survive restarts. Deployment-owned root and destination locations are
  reconciled from the environment on startup rather than replacing these settings.
- **Browser preferences** such as mute, panel layout, cut strategy, and filename
  template are local to one browser profile. They do not change shared server settings.

A media root is a path as seen by the server process. Configure roots in
`VIDEOCUTLIST_MEDIA_ROOTS_JSON`; startup reconciles configured aliases against
persisted roots. The Settings page displays safe root aliases and availability,
not paths or a path editor. The server indexes originals in place without copying them.

## Server configuration

Environment variables configure deployment settings and seed runtime settings
when the database is new:

```text
VIDEOCUTLIST_LISTEN_ADDRESS=127.0.0.1
VIDEOCUTLIST_PORT=8787
VIDEOCUTLIST_PUBLIC_BASE_URL
VIDEOCUTLIST_ALLOWED_ORIGINS
VIDEOCUTLIST_READ_TIMEOUT=15s
VIDEOCUTLIST_WRITE_TIMEOUT=0s
VIDEOCUTLIST_IDLE_TIMEOUT=60s
VIDEOCUTLIST_DATABASE_PATH
VIDEOCUTLIST_CACHE_DIR
VIDEOCUTLIST_EXPORT_DIR
VIDEOCUTLIST_DESTINATIONS_JSON
VIDEOCUTLIST_MEDIA_ROOTS_JSON
VIDEOCUTLIST_AUTH_MODE=none|bearer|trusted_proxy
VIDEOCUTLIST_BEARER_TOKEN
VIDEOCUTLIST_MCP_ENABLED=false
VIDEOCUTLIST_TRUSTED_PROXY_CIDRS
VIDEOCUTLIST_FFMPEG_PATH
VIDEOCUTLIST_FFPROBE_PATH
VIDEOCUTLIST_PREVIEW_GLOBAL_LIMIT
VIDEOCUTLIST_EXPORT_LIMIT
VIDEOCUTLIST_CACHE_MAX_BYTES
VIDEOCUTLIST_PREVIEW_BEFORE_MS
VIDEOCUTLIST_PREVIEW_AFTER_MS
VIDEOCUTLIST_PREVIEW_MAX_MS
VIDEOCUTLIST_PREVIEW_GRID_MS
```

Listener addresses must be IP literals. Read and idle timeouts must be positive
Go durations such as `15s`; write timeout may be zero so streamed previews are
not terminated by a whole-response deadline.

Public base URLs and allowed origins must be absolute HTTP(S) values without
credentials, query, or fragment. Origins also have no path.
`VIDEOCUTLIST_ALLOWED_ORIGINS` is comma-separated and empty by default; configure
exact origins rather than wildcards.

## Export destinations

`VIDEOCUTLIST_DESTINATIONS_JSON` is an optional deployment-owned array of export
destinations. By default, `download` (browser download) and `server` (a durable
server-side archive) are both rooted at `VIDEOCUTLIST_EXPORT_DIR`; a custom value
replaces these defaults.

A `source_adjacent` entry explicitly enables save-beside-source and must provide
its `mediaRoot`. This option is unavailable when the source cannot be verified
beneath that root or its adjacent export folder is not writable.
An omitted destination resolves only to a configured `download` entry; custom
configurations without one must select a destination explicitly.

## Native deployment

Run the service as a dedicated non-root account (for example `videocutlist`),
not as the account that owns the original media. Give that account directory
traverse and file-read permission on the complete native absolute path, without
making the media tree world-readable or writable. For example, inspect access
before starting the service:

```bash
namei -l /srv/media
sudo -u videocutlist find /srv/media -maxdepth 1 -type f -readable -print -quit
```

Create writable, separate locations for the database and exports, and a
disposable location for previews. The service account needs write access only
to those locations:

```bash
sudo install -d -o videocutlist -g videocutlist -m 0750 /var/lib/videocutlist/data
sudo install -d -o videocutlist -g videocutlist -m 0750 /var/lib/videocutlist/exports
sudo install -d -o videocutlist -g videocutlist -m 0750 /var/cache/videocutlist/previews
```

Set an absolute native root in the deployment environment:

```bash
VIDEOCUTLIST_DATABASE_PATH=/var/lib/videocutlist/data/videocutlist.db \
VIDEOCUTLIST_CACHE_DIR=/var/cache/videocutlist/previews \
VIDEOCUTLIST_EXPORT_DIR=/var/lib/videocutlist/exports \
VIDEOCUTLIST_MEDIA_ROOTS_JSON='{"media":"/srv/media"}' \
  /usr/local/bin/videocutlist
```

The root must be an existing directory readable by the service account. After
startup, use **Settings → Rescan library** to discover changes under the
configured roots. Changing a mount's contents does not require changing its
configured path. Root alias/path changes are reconciled on restart without
deleting the database, projects, or job history; media belonging to removed
aliases remains in history but is unavailable until its root is configured again.

## Docker and Podman

The image runs as non-root UID/GID `10001`. Keep source media in a separate
read-only bind mount and keep database, cache, and exports in distinct writable
mounts. The checked-in Compose file does this by default:

```yaml
volumes:
  - ./data:/var/lib/videocutlist/data
  - ./cache:/var/cache/videocutlist/previews
  - ./exports:/var/lib/videocutlist/exports
  - /srv/media:/srv/videocutlist/media:ro
```

Create a private environment file and generate the deployment bearer token
(requires OpenSSL):

```bash
umask 077
cp videocutlist.env.example videocutlist.env
printf 'VIDEOCUTLIST_BEARER_TOKEN=%s\n' "$(openssl rand -hex 32)" >> videocutlist.env
```

The container listens on `0.0.0.0`, so bearer authentication is required even
when the published host port is loopback-only. After startup, open
`http://127.0.0.1:8787` and enter the token from the private environment file.
The browser stores it only in memory, never in local/session storage, URLs, or
the Vite bundle. Reloading requires entering it again. A trusted-proxy deployment
instead handles sign-in at its proxy. Never commit the environment file.

Prepare writable directories with ownership usable by the container, and verify
that the media mount is read-only:

```bash
mkdir -p data cache exports
sudo chown 10001:10001 data cache exports
VIDEOCUTLIST_MEDIA_DIR=/srv/media docker compose up -d
# Podman: use `podman compose` in place of `docker compose`.
docker compose exec videocutlist sh -c 'id; test -r /srv/videocutlist/media; test ! -w /srv/videocutlist/media'
```

For rootless Podman, use the host UID/GID mapping reported by the runtime (or
`:U` only when its ownership relabeling is acceptable) rather than assuming
`10001` is mapped. SELinux-enabled hosts may also need the runtime's normal
read-only bind-label option; preserve the `:ro` flag. Do not make the media
mount writable just to solve an ownership error.

The example configures `/srv/videocutlist/media` as the container-visible root.
The host path belongs in `VIDEOCUTLIST_MEDIA_DIR`/Compose. For several source
directories, configure separate read-only mounts and corresponding
`VIDEOCUTLIST_MEDIA_ROOTS_JSON` aliases. Restart to reconcile aliases; Settings
shows those aliases and provides **Rescan library**.

Compose uses `ghcr.io/ar10dev/videocutlist:latest` unless `VIDEOCUTLIST_IMAGE`
is pinned. To build locally:

```bash
docker build -f Dockerfile -t videocutlist:local ../..
VIDEOCUTLIST_IMAGE=videocutlist:local docker compose up -d
```

For a local Podman development deployment, `make test-podman` builds and
replaces `videocutlist-local`. It retains the database under
`$VIDEOCUTLIST_APP_DIR/data` (default
`~/.config/podman/videocutlist/data`) and the exports on redeploy. Back up
these directories before intentionally resetting them; the deploy script does
not erase them.

The script creates private files with `umask 077` and sets `videocutlist.env`
to owner-only mode `0600`, including when reusing an existing environment file.

## Separately hosted browser client

The bundled client uses the current page origin by default. If you host the
client separately, set `window.VIDEOCUTLIST_CONFIG` before its application module
loads:

```js
window.VIDEOCUTLIST_CONFIG = {
  serverBaseUrl: "https://api.example.test",
  authentication: { type: "none" },
};
```

Requests use `<serverBaseUrl>/api/v1/`. With bearer authentication, the browser
offers an access form after a 401 and keeps the supplied token only in memory.
Do not embed a bearer token in a public frontend build or configuration file.
Use `authentication: { type: "cookie" }` when a proxy authenticates requests
with cookies. Allow the exact client origin through
`VIDEOCUTLIST_ALLOWED_ORIGINS` and use HTTPS for both origins.

## Persistence, backup, and security

Back up the SQLite database (including the persisted runtime settings) and any
exports that must be retained. Back up `videocutlist.env` and Compose files as
deployment configuration, separately from original media. Preview cache files
and `.partial` files are disposable and may be removed using the [cache
recovery runbook](cache-recovery.md). The application must not be used to copy
or back up source media; protect and back up originals through the storage
system that owns them. See [export recovery](export-recovery.md) for durable
export handling.

Native startup defaults to a loopback listener. Compose publishes to loopback
on the host but uses an authenticated wildcard listener inside the container.
Keep the host binding local unless remote exposure is deliberate:

1. Enable `VIDEOCUTLIST_AUTH_MODE=bearer` with a long secret token, or put the
   service behind an authenticating TLS reverse proxy.
2. Terminate TLS at that proxy, restrict its upstream to `127.0.0.1:8787`, and
   configure exact `VIDEOCUTLIST_ALLOWED_ORIGINS` values when the browser is on
   a different origin.
3. With `trusted_proxy`, set `VIDEOCUTLIST_TRUSTED_PROXY_CIDRS` only to the
   proxy's immediate source CIDR(s). This is an identity-free access gate: the
   application allows those proxy requests but does not establish an application
   identity. Enforce user or network access in the proxy or surrounding network.
4. Set `VIDEOCUTLIST_BIND_ADDRESS=0.0.0.0` only with the authentication,
   firewall, and TLS controls above. `auth=none` is for a trusted local
   single-user boundary, not a LAN or internet listener.

See the [reverse-proxy contract](../../deployments/reverse-proxy/README.md) for
proxy-specific constraints.

Browser export downloads stream through a same-origin service worker at
`/download-sw.js`, scoped to `/download-stream/`. The client origin must be a
secure browser context (HTTPS, or trusted localhost/loopback HTTP) and must
serve that script as JavaScript; hosting the UI under a path prefix without
serving the worker at the origin root will disable downloads. If the API is on
another origin, allow the exact client origin and `Authorization` preflights
through `VIDEOCUTLIST_ALLOWED_ORIGINS`; a HTTPS client must use a HTTPS API to
avoid mixed-content blocking. Browser bearer tokens remain in memory and are
never placed in download URLs or persistent storage.

## Troubleshooting

- **Root missing in Settings:** check the configured root aliases, the
  server-visible directory, and its read-only Compose mount. Settings is not
  a path editor; update the deployment environment and restart to reconcile
  roots without deleting saved projects or job history.
- **Native directory unreadable:** inspect every parent with `namei -l` and
  test as the service account. Grant only required traverse/read access (ACLs
  are preferable to broad mode changes); never use `chmod -R 777`.
- **Symlink or allowlist rejection:** resolve the final target and ensure it is
  beneath the configured allowlisted base, if one is supplied. Remove the
  out-of-tree link or choose a permitted root; do not disable path checks.
- **Rescan fails:** check `docker compose logs videocutlist` (or the system
  service journal), verify the mount and read permissions, and confirm the
  configured root is a directory. Fix the deployment and retry Rescan; do not
  delete the database or make source media writable.
- **Writes fail:** verify database/cache/export ownership for UID/GID `10001`
  (or the rootless Podman mapping), free space, and that only the source mount
  is read-only.

Check service state with either runtime:

```bash
docker compose ps
docker compose logs -f videocutlist
# podman compose ps
# podman compose logs -f videocutlist
```
