# 66: Fix remaining segment-selection Playwright failures

**What to build:** Make the remaining segment-selection browser tests conform to the current settings and media-tree contracts so the full Playwright suite passes.

**Blocked by:** 65

**Category:** bug
**Status:** needs-review

- [x] Remaining fixture failures diagnosed and partially fixed without weakening assertions.
- [ ] Remaining `segment-selection.spec.ts` failures are fixed.
- [ ] All browser fixture routes satisfy current media-tree and settings contracts.
- [ ] Full Playwright passes.
- [ ] Ticket 11 and ticket 65 are updated to completed only with full validation evidence.
- [ ] `make check` passes after final edits.

## Comments

- Updated media-tree/status fixtures, detection job IDs, empty-library messaging, and editor detail visibility.
- Focused detection coverage passes (2/2).
- Full segment-selection suite remains incomplete: 22/30 passed; preview timing, preflight/export lifecycle, and delayed cancellation cases still fail.
- Commit: `434d54f`.
- Follow-ups opened: ticket 67 for preview/marker timing and ticket 68 for remaining export/delayed lifecycle failures.
