# 68: Fix export and delayed lifecycle Playwright failures

**What to build:** Repair remaining segment-selection export, preflight, delayed save/project, unmount, and cancellation browser fixtures or lifecycle regressions while preserving assertions.

**Blocked by:** 66

**Category:** bug
**Status:** completed

- [x] Preflight and export polling tests pass with current generated job contracts.
- [x] Active and delayed cancellation tests pass without stale state restoration.
- [x] Delayed project/save/unmount tests pass without obsolete work launching.
- [x] New-project lifecycle test passes.
- [x] Relevant Playwright tests and `make check` pass.

## Comments

Opened from ticket 66: export/preflight and delayed lifecycle cases remain among the 8 failing segment-selection tests.

- Ticket 69 approved and implemented save → fresh preflight → submit semantics; tickets 73–74 completed delayed cancellation, retry, and interchange coverage.
- Validation: full Playwright (43 tests) and `make check` pass.
