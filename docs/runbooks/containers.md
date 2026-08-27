# Deployment and settings guide

VideoCutlist has two kinds of configuration:

- **Deployment configuration** comes from the process environment and Compose.
  It includes the listener, authentication, proxy/CORS policy, database/cache/
  export locations, and the host-to-container mounts.
- **Runtime settings** are administrator-only settings stored in the SQLite
  database. They include media roots, destinations, preview/export limits, and
  scan/cache policy. On a new database, the environment values seed the first
  runtime-settings document; after that, changing the environment does not
  overwrite settings saved through the Settings API.

A media root is a path as seen by the server process. The server indexes media
in place and does not copy original media. Never enter a host path in Settings
when the server runs in a container.

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
a disposable location for previews. The service account needs write access only
 to those locations:

```bash
sudo install -d -o videocutlist -g videocutlist -m 0750 /var/lib/videocutlist/data
sudo install -d -o videocutlist -g videocutlist -m 0750 /var/lib/videocutlist/exports
sudo install -d -o videocutlist -g videocutlist -m 0750 /var/cache/videocutlist/previews
```

Set an absolute native root in the environment for the initial database seed:

```bash
VIDEOCUTLIST_DATABASE_PATH=/var/lib/videocutlist/data/videocutlist.db \
VIDEOCUTLIST_CACHE_DIR=/var/cache/videocutlist/previews \
VIDEOCUTLIST_EXPORT_DIR=/var/lib/videocutlist/exports \
VIDEOCUTLIST_MEDIA_ROOTS_JSON='{"media":"/srv/media"}' \
  /usr/local/bin/videocutlist
```

Alternatively, an authenticated administrator can add or edit the absolute root
in **Settings → Media roots**, then use **Rescan**. The root must be an
existing directory readable by the service account. The current server binary
does not configure a non-empty media-root allowlist; where a deployment or
embedding supplies one, each root must remain beneath an allowlisted absolute
base after symlink resolution. Do not work around a rejection by broadening
permissions or creating an unsafe symlink.

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

After the container starts, enter `/srv/videocutlist/media` (the
container-visible path) as the media root in Settings. The host path belongs
only in `VIDEOCUTLIST_MEDIA_DIR`/Compose. If using several source directories,
add separate read-only mounts and one matching container-visible alias for each.

Compose uses `ghcr.io/ar10dev/videocutlist:latest` unless `VIDEOCUTLIST_IMAGE`
is pinned. To build locally:

```bash
docker build -f Dockerfile -t videocutlist:local ../..
VIDEOCUTLIST_IMAGE=videocutlist:local docker compose up -d
```

## Persistence, backup, and security

Back up the SQLite database (including the persisted runtime settings) and any
exports that must be retained. Back up `videocutlist.env` and Compose files as
deployment configuration, separately from original media. Preview cache files
and `.partial` files are disposable and may be removed using the [cache
recovery runbook](cache-recovery.md). The application must not be used to copy
or back up source media; protect and back up originals through the storage
system that owns them. See [export recovery](export-recovery.md) for durable
export handling.

The default listener and Compose port binding are loopback-only. Keep them that
way for local use. Before any remote exposure:

1. Enable `VIDEOCUTLIST_AUTH_MODE=bearer` with a long secret token, or put the
   service behind an authenticating TLS reverse proxy.
2. Terminate TLS at that proxy, restrict its upstream to `127.0.0.1:8787`, and
   configure exact `VIDEOCUTLIST_ALLOWED_ORIGINS` values when the browser is on
   a different origin.
3. With `trusted_proxy`, set `VIDEOCUTLIST_TRUSTED_PROXY_CIDRS` only to the
   proxy's immediate source CIDR(s). The proxy must overwrite, not forward,
   client-supplied `X-Forwarded-User`; do not use this mode without proxy
   authentication.
4. Set `VIDEOCUTLIST_BIND_ADDRESS=0.0.0.0` only with the authentication,
   firewall, and TLS controls above. `auth=none` is for a trusted local
   single-user boundary, not a LAN or internet listener.

See the [reverse-proxy contract](../../deployments/reverse-proxy/README.md) for
proxy-specific constraints.

## Troubleshooting

- **Root missing in Settings:** confirm that the native absolute directory
  exists, or that the Compose host directory is mounted at the exact path you
  entered. In a container, use `/srv/videocutlist/media`, not `/srv/media`.
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
