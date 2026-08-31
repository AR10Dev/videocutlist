# 70: Triage remaining browser regressions

**What to build:** Diagnose the seven remaining segment-selection Playwright failures after the save-on-export migration, split unrelated failure clusters into implementation tickets, and accurately update ticket 69 tracking.

**Blocked by:** 69

**Category:** bug
**Status:** wontfix

- [x] The remaining browser failures are grouped by root cause with exact test evidence.
- [x] Each independently fixable root cause has a correctly scoped ready-for-agent ticket.
- [x] Ticket 69 status/checklist reflects only its validated save-on-export behavior.
- [x] No speculative product change is introduced.

## Comments

- Preview offset and watched-marker failures were tracked by ticket 67.
- Export and cancellation lifecycle failures were tracked by tickets 68 and 69.
- Detection context-change and new-project failures were tracked by tickets 71 and 72, then completed through ticket 73.
- Retained as `wontfix` because the triage work is complete. Validation recorded by ticket 73: full segment-selection Playwright passes (30 tests) and `make check` passes.
