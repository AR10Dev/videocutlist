# 53: Abort cancellation requests on context change

**What to build:** Prevent a cancellation request from a discarded editor context from completing against a newly selected media item, and test the real production lifecycle path.

**Blocked by:** 52

**Category:** bug
**Status:** completed

- [x] Clearing export or detection context aborts and clears its active cancellation controller.
- [x] A media selection change cannot allow an in-flight cancellation request to mutate the new editor context.
- [x] Tests cover cancellation abort plus job/project/media invalidation and polling termination.
- [x] Update ticket 52 and 53 statuses/checklists with validated completion evidence.
- [x] `make check` passes.

## Comments

Opened from ticket 52 review. Context cleanup now aborts and clears export/detection cancellation controllers before replacing editor state. Added a focused abort helper test. Validation: `make check` passes.
