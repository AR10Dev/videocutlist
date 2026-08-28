# 02: Build batch project operations

**What to build:** A project module that loads and saves multi-item projects through one small interface while enforcing revision and media constraints internally.

**Blocked by:** 01

**Category:** enhancement
**Status:** completed

- [x] Create, get, and save operations accept no user or owner argument.
- [x] Saving validates every item ID, media ID, segment list, editor state, and export option.
- [x] Segment bounds use the current duration of each referenced media item.
- [x] Missing or unavailable media produces a stable item-specific validation error without deleting the project item.
- [x] A stale expected revision returns a conflict and preserves the stored project.
- [x] Successful saves increment revision exactly once in the same transaction.
- [x] Tests exercise repeated media, several project items, stale saves, missing media, and atomic validation failure.

## Comments

- Added owner-free project create/get/save ports, catalog-backed validation for every batch item, and stable item-specific unavailable-media errors. Existing legacy HTTP input remains a one-item adapter until ticket 11 replaces the API contract.
- `make check` passed.
