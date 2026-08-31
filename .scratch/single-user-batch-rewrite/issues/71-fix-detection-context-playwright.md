# 71: Fix detection context Playwright regression

**What to build:** Restore the detection-results context-change browser flow so a pending or completed detection job is cleared when selecting a different media item, without weakening cancellation and stale-state assertions.

**Blocked by:** 70

**Category:** bug
**Status:** wontfix

- [x] `clears detection results when media context changes` passes.
- [x] Detection job/candidate/status state cannot overwrite the newly selected media context.
- [x] Relevant segment-selection Playwright coverage and `make check` pass.

## Comments

- Split from ticket 70.
- Ticket 73 completed this work while fixing the remaining detection and export lifecycle failures.
- Retained as `wontfix` because ticket 73 superseded the implementation ticket. Validation: full segment-selection Playwright passes (30 tests) and `make check` passes.
