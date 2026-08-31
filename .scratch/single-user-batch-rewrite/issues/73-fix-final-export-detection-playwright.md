# 73: Fix final export and detection Playwright lifecycle failures

**What to build:** Resolve the remaining detection context timeout and export retry/cancellation lifecycle assertions without weakening the save-on-export or stale-context contracts.

**Blocked by:** 67, 69, 71, 72

**Category:** bug
**Status:** wontfix

- [x] Detection context-change test completes without a timeout and preserves cancellation safety.
- [x] Failed/capacity export retry becomes available after terminal failure under save-on-export semantics.
- [x] Export cancellation presents the terminal cancelled status without exposing paths.
- [x] Delayed cancellation cannot overwrite replacement export state.
- [x] Full Playwright and `make check` pass.

## Comments

Opened after integrating tickets 67, 71, and 72 left four segment-selection lifecycle failures.

- Detection fixtures now match generated job IDs; export cancellation clears the active UI context immediately, preserves stale guards, and avoids refetch overwrites; failed submissions clear pending preflight state for retry.
- Validation: full `playwright/segment-selection.spec.ts` (30 passed), `make check` (77 client tests) pass.
