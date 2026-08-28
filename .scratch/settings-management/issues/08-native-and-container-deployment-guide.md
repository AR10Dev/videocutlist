# 08: Document native and container settings deployment

**What to build:** Publish one deployment guide that explains how server settings interact with native filesystem permissions and Docker/Podman mounts.

**Blocked by:** 01, 03, 04

**Category:** enhancement
**Status:** wontfix

- [ ] Native instructions show a service-account-readable absolute media path added through Settings and explain any configured allowlisted bases.
- [ ] Docker and Podman instructions show separate read-only media mounts and writable data/cache/export mounts, then entering the container-visible media path in Settings.
- [ ] The guide includes UID/GID ownership guidance for persistent writable mounts and verifies media mounts remain read-only.
- [ ] The guide identifies what to back up (database/settings) and what is disposable (cache), without recommending backup of source media through the application.
- [ ] Networking guidance retains loopback-by-default and documents authentication, TLS/reverse proxy, and trusted-proxy configuration before remote exposure.
- [ ] Troubleshooting covers missing container mount, unreadable native directory, symlink/allowlist rejection, and rescan failure without encouraging unsafe permission changes.

## Comments

Superseded by `.scratch/single-user-batch-rewrite/`. Revised deployment documentation is tracked by issue 13 of that feature.

Research basis: official Jellyfin and Navidrome container guidance uses distinct, read-only media mounts and separate writable application data; desktop tools similarly separate source/project folders from cache and outputs.
