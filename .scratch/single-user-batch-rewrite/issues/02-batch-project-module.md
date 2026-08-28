# 02: Build batch project operations

**What to build:** A project module that loads and saves multi-item projects through one small interface while enforcing revision and media constraints internally.

**Blocked by:** 01

**Category:** enhancement
**Status:** ready-for-agent

- [ ] Create, get, and save operations accept no user or owner argument.
- [ ] Saving validates every item ID, media ID, segment list, editor state, and export option.
- [ ] Segment bounds use the current duration of each referenced media item.
- [ ] Missing or unavailable media produces a stable item-specific validation error without deleting the project item.
- [ ] A stale expected revision returns a conflict and preserves the stored project.
- [ ] Successful saves increment revision exactly once in the same transaction.
- [ ] Tests exercise repeated media, several project items, stale saves, missing media, and atomic validation failure.

## Comments
