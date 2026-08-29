# 52: Fix Solid Query cancellation and contract lifecycle gaps

**What to build:** Make job cancellation genuinely abortable, invalidate all dependent state immediately after cancellation, remove obsolete controller code and handwritten generated-contract duplicates, and prove the real application lifecycle behavior with tests.

**Blocked by:** 51

**Category:** bug
**Status:** ready-for-agent

- [ ] Each export and detection cancellation mutation retains an AbortController and aborts it on context change or unmount.
- [ ] A successful export or detection cancellation immediately invalidates its job plus related project and media queries.
- [ ] Tests invoke the production lifecycle helpers or handlers and assert cancellation plus job/project/media invalidation, terminal polling shutdown, and stale-response protection.
- [ ] The dead `_loadMedia` controller/version lifecycle is removed.
- [ ] `preview.ts` uses generated OpenAPI Media and Segment schemas rather than handwritten duplicates.
- [ ] `make check` passes.

## Comments

Opened from ticket 51 review findings. Ticket 51 remains unmerged until this fix is reviewed with it.
