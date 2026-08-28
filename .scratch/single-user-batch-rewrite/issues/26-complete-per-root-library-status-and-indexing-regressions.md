# 26: Complete per-root library status and indexing regressions

**What to build:** Expose safe per-root scan readiness/failure and cover atomic catalog-preservation behavior under all required scan failures.

**Blocked by:** 07

**Category:** bug
**Status:** completed

- [x] Library status exposes safe per-root ready or failure results without root paths.
- [x] Cancellation and scan-limit failures preserve the prior root catalog.
- [x] Replacement scanning marks removed files unavailable.
- [x] SQLite `MediaStore.Sync` rollback preserves prior catalog when replacement fails.

## Comments

- Opened from post-merge review of ticket 07. Indexing itself is root-isolated and transactional, but the application exposes only aggregate status and regression coverage misses catalog preservation for cancellation/scan-limit, removed-file replacement, and SQLite rollback.
- Added path-free per-root scanner statuses and exposed them through the application library status contract. Added regressions for unavailable roots, scan-limit preservation, and real SQLite transaction rollback. `make check` passes.
