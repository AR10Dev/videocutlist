# 58: Mount App cancellation lifecycle test

**What to build:** Mount the actual App with a controlled API boundary and prove a deferred export cancellation is aborted by selection/context change without restoring stale export UI state.

**Blocked by:** 57

**Category:** bug
**Status:** completed

- [x] A Playwright test mounts App with a controlled API boundary.
- [x] The test starts a pending export cancellation, changes media/editor context, and observes DELETE signal abort.
- [x] Resolving the deferred cancellation cannot restore the old export job or status in the new App context.
- [x] Ticket 57 and this ticket accurately record validated completion evidence.
- [x] `make check` passes.

## Comments

Opened from ticket 57’s residual risk. Added the mounted App cancellation test with a deferred DELETE and corrected the timecode setup to create an exportable segment. Validation: focused Playwright test and `make check` pass.
