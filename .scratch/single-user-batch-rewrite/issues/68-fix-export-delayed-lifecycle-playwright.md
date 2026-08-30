# 68: Fix export and delayed lifecycle Playwright failures

**What to build:** Repair remaining segment-selection export, preflight, delayed save/project, unmount, and cancellation browser fixtures or lifecycle regressions while preserving assertions.

**Blocked by:** 66

**Category:** bug
**Status:** needs-review

- [ ] Preflight and export polling tests pass with current generated job contracts.
- [ ] Active and delayed cancellation tests pass without stale state restoration.
- [ ] Delayed project/save/unmount tests pass without obsolete work launching.
- [ ] New-project lifecycle test passes.
- [ ] Relevant Playwright tests and `make check` pass.

## Comments

Opened from ticket 66: export/preflight and delayed lifecycle cases remain among the 8 failing segment-selection tests.

- Blocker: focused lifecycle run still fails 4 of 5 selected tests (`exports the saved`, `cancels an active`, `delayed saves`, and `delayed cancellation`); only unmounting the deferred export save passes.
- Root cause requiring product/lifecycle decision: `App.tsx` disables Start export while the project is dirty or preflight is unavailable, while delayed-export tests expect the action to save dirty edits before preflight/export. No speculative behavior change was made.
- Validation: inherited `make check` passes, but the focused Playwright lifecycle command fails; no implementation diff remains from this attempt.
