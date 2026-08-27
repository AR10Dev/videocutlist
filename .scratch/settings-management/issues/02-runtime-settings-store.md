# 02: Persist validated server runtime settings

**What to build:** Add a versioned SQLite-backed server runtime-settings store with atomic read/update semantics and typed validation. Seed it from deployment defaults only on first startup; later restarts retain administrator changes.

**Blocked by:** 01

**Category:** enhancement
**Status:** proposed

- [ ] A database migration creates durable settings storage with a schema version/update timestamp and no secrets.
- [ ] Reads return one complete effective settings document, including a revision used for optimistic concurrency.
- [ ] Updates validate the entire candidate document before atomically replacing it; stale revisions return 409.
- [ ] First startup seeds unset runtime settings from existing environment defaults without overwriting an existing stored value.
- [ ] Invalid stored data fails startup clearly without silently reverting to unsafe defaults.
- [ ] Unit tests cover first-run seeding, restart persistence, validation, atomic rejection, and revision conflicts.

## Comments

Do not use a generic untyped key/value blob as the application API. A typed document keeps validation and future migrations explicit while retaining a small implementation.
