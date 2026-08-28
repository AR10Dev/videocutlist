# 07: Publish media scans atomically per root

**What to build:** Media indexing that preserves the last usable catalog for a root until a complete bounded replacement scan succeeds.

**Blocked by:** 01

**Category:** bug
**Status:** ready-for-agent

- [ ] Each root scan accumulates a complete replacement set before changing availability in that root.
- [ ] Replacement, insertion, and removed-media availability updates commit in one SQLite transaction per root.
- [ ] Cancellation, probe failure, scan-limit failure, or filesystem failure leaves the previous root catalog usable.
- [ ] One failed root does not discard successful results from another root.
- [ ] Library status reports safe per-root readiness or failure without returning root paths.
- [ ] Removing a configured root hides its records only after the configuration change succeeds.
- [ ] Tests cover partial scans, cancellation, removed files, removed roots, and mixed success across roots.

## Comments
