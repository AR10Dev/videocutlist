# 03: Safely reconfigure media libraries at runtime

**What to build:** Let an administrator add, edit, remove, and rescan named media roots without restarting the server. Native servers accept readable absolute directories; containers accept only paths visible inside the container.

**Blocked by:** 01, 02

**Category:** enhancement
**Status:** wontfix

- [ ] A media root has a unique non-empty alias and an absolute directory path; aliases are stable inputs to existing opaque media IDs.
- [ ] Before save, the server resolves symlinks, verifies the directory is readable, and rejects invalid paths.
- [ ] Optional deployment allowlisted base directories constrain configured roots after canonical resolution; without an allowlist, native installations may use any readable absolute directory available to the service account.
- [ ] A root change swaps the active library configuration atomically: concurrent requests complete against either the old or new valid configuration, never a partially changed map.
- [ ] Root removal makes its media unavailable and removes stale catalog records without exposing source paths.
- [ ] Saving roots starts or requests a rescan; scan status reports root aliases and safe error summaries, never raw source paths.
- [ ] Existing path-containment and symlink protections remain true for preview, assets, exports, and media lookup.
- [ ] Tests cover duplicate aliases, relative/missing/unreadable paths, symlink escape, allowlist escape, concurrent read/update, removal, and rescan behavior.

## Comments

Superseded by `.scratch/single-user-batch-rewrite/`. Media roots become deployment-only and scans move to the durable local queue.

The current scanner is constructed once at server startup and is shared by indexing, preview, assets, exports, and detection. Reconfiguration must update that shared resolution boundary rather than patching only the refresh endpoint.
