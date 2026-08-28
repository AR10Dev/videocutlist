# 07: Publish media scans atomically per root

**What to build:** Media indexing that preserves the last usable catalog for a root until a complete bounded replacement scan succeeds.

**Blocked by:** 01

**Category:** bug
**Status:** completed

- [x] Each root scan accumulates a complete replacement set before changing availability in that root.
- [x] Replacement, insertion, and removed-media availability updates commit in one SQLite transaction per root.
- [x] Cancellation, probe failure, scan-limit failure, or filesystem failure leaves the previous root catalog usable.
- [x] One failed root does not discard successful results from another root.
- [x] Library status reports safe per-root readiness or failure without returning root paths.
- [x] Removing a configured root hides its records only after the configuration change succeeds.
- [x] Tests cover partial scans, cancellation, removed files, removed roots, and mixed success across roots.

## Comments

- Completed atomic per-root refresh publication. Scan failures now leave that root untouched while other roots continue and publish independently; probe and filesystem failures no longer silently replace a usable catalog with a partial result. Added focused mixed-root and probe-failure regression tests.
