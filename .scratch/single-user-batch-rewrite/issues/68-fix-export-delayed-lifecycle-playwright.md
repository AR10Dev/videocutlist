# 68: Fix export and delayed lifecycle Playwright failures

**What to build:** Repair remaining segment-selection export, preflight, delayed save/project, unmount, and cancellation browser fixtures or lifecycle regressions while preserving assertions.

**Blocked by:** 66

**Category:** bug
**Status:** ready-for-agent

- [ ] Preflight and export polling tests pass with current generated job contracts.
- [ ] Active and delayed cancellation tests pass without stale state restoration.
- [ ] Delayed project/save/unmount tests pass without obsolete work launching.
- [ ] New-project lifecycle test passes.
- [ ] Relevant Playwright tests and `make check` pass.

## Comments

Opened from ticket 66: export/preflight and delayed lifecycle cases remain among the 8 failing segment-selection tests.
