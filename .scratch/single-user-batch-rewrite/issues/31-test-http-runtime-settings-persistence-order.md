# 31: Test HTTP runtime-settings persistence order

**What to build:** Add integration coverage proving settings persistence and runtime application remain mutually consistent through the HTTP update path.

**Blocked by:** 30

**Category:** bug
**Status:** completed

- [x] A failed runtime application through `putSettings` leaves persisted settings unchanged.
- [x] A failed settings persistence restores previously applied runtime settings.

## Comments

- Opened from post-merge review of ticket 30. Unit tests cover runtime rollback, but no HTTP/integration regression proves the full persistence ordering or rollback after `Settings.Update` failure.
- Added HTTP integration tests for runtime-apply failure and injected SQLite persistence failure; `make check` passes.
