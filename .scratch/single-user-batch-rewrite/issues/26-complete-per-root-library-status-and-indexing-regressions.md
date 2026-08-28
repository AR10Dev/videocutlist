# 26: Complete per-root library status and indexing regressions

**What to build:** Expose safe per-root scan readiness/failure and cover atomic catalog-preservation behavior under all required scan failures.

**Blocked by:** 07

**Category:** bug
**Status:** ready-for-agent

- [ ] Library status exposes safe per-root ready or failure results without root paths.
- [ ] Cancellation and scan-limit failures preserve the prior root catalog.
- [ ] Replacement scanning marks removed files unavailable.
- [ ] SQLite `MediaStore.Sync` rollback preserves prior catalog when replacement fails.

## Comments

- Opened from post-merge review of ticket 07. Indexing itself is root-isolated and transactional, but the application exposes only aggregate status and regression coverage misses catalog preservation for cancellation/scan-limit, removed-file replacement, and SQLite rollback.
