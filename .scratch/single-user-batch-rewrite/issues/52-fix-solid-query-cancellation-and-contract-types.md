# 52: Fix Solid Query cancellation and contract lifecycle gaps

**What to build:** Make job cancellation genuinely abortable, invalidate all dependent state immediately after cancellation, remove obsolete controller code and handwritten generated-contract duplicates, and prove the real application lifecycle behavior with tests.

**Blocked by:** 51

**Category:** bug
**Status:** completed

- [x] Each export and detection cancellation mutation retains an AbortController and aborts it on context change or unmount.
- [x] A successful export or detection cancellation immediately invalidates its job plus related project and media queries.
- [x] Tests invoke the production lifecycle helpers or handlers and assert cancellation plus job/project/media invalidation, terminal polling shutdown, and stale-response protection.
- [x] The dead `_loadMedia` controller/version lifecycle is removed.
- [x] `preview.ts` uses generated OpenAPI Media and Segment schemas rather than handwritten duplicates.
- [x] `make check` passes.

## Comments

Opened from ticket 51 review findings. Completed in combination with tickets 53 and 54: cancellation context cleanup and generated contract types are in place, and production lifecycle behavior is covered by focused tests. Validation: `make check` passes.
