# 01: Define runtime-settings scope and administrator authorization

**What to build:** Establish a durable split between deployment bootstrap configuration, server runtime settings, and browser-only preferences. Add an authorization action for reading and changing server runtime settings; it must be enforced by HTTP handlers, not inferred from the Settings UI.

**Blocked by:** None

**Category:** enhancement
**Status:** wontfix

- [ ] Deployment-only values remain environment-loaded: database path, listener and port, authentication/secrets, trusted proxy/CORS policy, FFmpeg/FFprobe paths, and container mounts.
- [ ] Server runtime values have an explicit typed contract: media roots, export defaults/destinations, preview limits, cache policy, and scan limits.
- [ ] Browser-only editor preferences remain local to the browser profile and are not written to the server settings store.
- [ ] Every server-settings read/write operation requires a named `settings:manage` capability (or equivalent); missing capability returns 403 without revealing configuration.
- [ ] The built-in local/no-auth mode has documented administrator behavior; remote deployments require configured authentication before settings can be managed.
- [ ] The frozen runtime contract and deployment documentation describe these scopes and the authorization action.

## Comments

Superseded by `.scratch/single-user-batch-rewrite/`. The approved single-user design removes capabilities and keeps filesystem paths deployment-only.

Research basis: LosslessCut and Shotcut separate application preferences from generated data; Kdenlive separates global and project settings. Jellyfin’s setup/networking guidance distinguishes administrator controls from normal user access.
