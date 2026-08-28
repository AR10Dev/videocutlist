# 15: Return the project envelope revision

**What to build:** Project create, get, and save responses expose the persisted envelope revision needed for optimistic batch saves without duplicating revision inside the editable document.

**Blocked by:** 02

**Category:** bug
**Status:** ready-for-agent

- [ ] Project create, get, and save responses include the current `revision` as an envelope field.
- [ ] The editable project document still does not serialize a duplicate revision.
- [ ] A client can use a returned revision for the next save and receive the incremented revision.
- [ ] Regression tests cover revision serialization and sequential optimistic saves.

## Comments

- Opened from post-merge review of ticket 02: `domain.Document.Revision` is intentionally not serialized, but `application.Project` exposes no separate response field. Clients therefore cannot obtain an expected revision for a subsequent save.
