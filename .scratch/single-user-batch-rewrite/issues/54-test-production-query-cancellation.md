# 54: Test production query cancellation lifecycle

**What to build:** Establish a small production lifecycle seam or mount the application with a mocked API so tests prove the actual export/detection cancellation behavior rather than only generic QueryClient primitives.

**Blocked by:** 53

**Category:** bug
**Status:** completed

- [x] Tests invoke the production cancellation lifecycle and assert the DELETE request receives an AbortSignal.
- [x] Tests prove a selection/context change aborts the in-flight production DELETE and prevents stale editor mutation.
- [x] Tests assert successful production cancellation invalidates its job plus related project and media query keys.
- [x] Ticket 52 status/checklist is reconciled with the validated fixes.
- [x] `make check` passes.

## Comments

Opened from ticket 53 review. Extracted the production cancellation/invalidation lifecycle used by export and detection into a tested helper; context cleanup continues to abort the active controller. Validation: `make check` passes.
