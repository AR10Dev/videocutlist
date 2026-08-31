# 66: Fix remaining segment-selection Playwright failures

**What to build:** Make the remaining segment-selection browser tests conform to the current settings and media-tree contracts so the full Playwright suite passes.

**Blocked by:** 65

**Category:** bug
**Status:** wontfix

- [x] Remaining fixture failures diagnosed and fixed without weakening assertions.
- [x] Remaining `segment-selection.spec.ts` failures are fixed.
- [x] All browser fixture routes satisfy current media-tree and settings contracts.
- [x] Full Playwright passes.
- [x] Ticket 11 and ticket 65 are updated to completed with full validation evidence.
- [x] `make check` passes after final edits.

## Comments

- Updated media-tree/status fixtures, detection job IDs, empty-library messaging, and editor detail visibility.
- Focused detection coverage passes (2/2).
- Follow-up tickets 67–74 resolved preview, export, cancellation, and interchange lifecycle cases.
- Validation: full Playwright (43 tests) and `make check` pass.
