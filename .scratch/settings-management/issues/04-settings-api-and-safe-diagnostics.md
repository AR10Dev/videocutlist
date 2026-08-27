# 04: Expose the administrator settings API

**What to build:** Provide a small authenticated API for effective server settings, validated update, library rescan, and deployment diagnostics needed by the Settings UI.

**Blocked by:** 01, 02, 03

**Category:** enhancement
**Status:** proposed

- [ ] `GET /api/v1/settings` returns the authorized administrator’s effective server runtime settings, revision, root health, and whether paths are constrained by deployment allowlists.
- [ ] `PUT /api/v1/settings` accepts a complete typed document and required revision, returns 409 on a stale revision, and never partially applies a change.
- [ ] `POST /api/v1/settings/media/refresh` requests a rescan and returns an operation/status response compatible with the existing media-refresh behavior.
- [ ] Every endpoint requires the settings-management capability and returns 403 before parsing or revealing settings to unauthorized callers.
- [ ] Diagnostics distinguish native vs container-visible path failures and show only safe, action-oriented messages; raw paths are returned only by the settings endpoint to an authorized administrator.
- [ ] OpenAPI/runtime documentation and handler tests cover routing, authorization, validation, stale updates, and no-path-leak error responses.

## Comments

Keep ordinary media endpoints unchanged: IDs, folder labels, and records must remain path-free.
