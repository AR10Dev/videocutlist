# 55: Guard export cancellation after context changes

**What to build:** Ensure an export cancellation completing after its editor context is discarded cannot write stale job or status state, and prove it with an in-flight production lifecycle test.

**Blocked by:** 54

**Category:** bug
**Status:** completed

- [x] Export cancellation writes state only while its retained controller is current and not aborted.
- [x] A pending production export DELETE is aborted by selection/context cleanup and cannot restore old export state afterward.
- [x] Tests drive the production cancellation lifecycle through a pending DELETE, context cleanup, completion, and assertions that stale state is not written.
- [x] Tickets 50, 51, 53, and 54 accurately reflect unverified criteria until this test passes.
- [x] `make check` passes.

## Comments

Opened from ticket 54 review. Cancellation completion now checks controller identity and abort state before mutating export or detection state. Added focused lifecycle coverage for discarded contexts. Validation: client tests and production build pass.
