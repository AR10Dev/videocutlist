# Settings management

**Status:** wontfix

Superseded by `.scratch/single-user-batch-rewrite/`, which makes filesystem paths deployment-only and removes multi-user administrator authorization.

## Goal

Provide an administrator Settings destination in the browser UI for server runtime settings, including media libraries, while supporting both native server paths and container-visible paths. Preserve the existing media-ID/path privacy contract.

## Scope rules

- Browser preferences remain local to a browser profile.
- Server runtime settings persist in SQLite and apply to all clients.
- Deployment settings remain environment-only: database path, listener, authentication, trusted proxy/CORS policy, executable paths, and container mounts.
- A native deployment may add any readable absolute directory as a media root. A container deployment may add only an existing container-visible directory, which requires a host bind mount configured outside the app.
- Sources are read-only. Export and cache storage are separate writable locations.
- Raw source paths must never appear in ordinary media, project, preview, job, or log output. They may appear only in the administrator Settings view to a principal authorized to manage settings.

## Research

See `docs/research/competitor-settings.md` and the cited primary sources there. The implementation is informed by LosslessCut’s application preferences, Kdenlive’s global/project folder separation, Shotcut’s distinct proxy/cache storage, and self-hosted media servers’ read-only media mounts plus separate writable data.
