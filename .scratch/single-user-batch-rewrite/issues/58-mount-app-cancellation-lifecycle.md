# 58: Mount App cancellation lifecycle test

**What to build:** Mount the actual App with a controlled API boundary and prove a deferred export cancellation is aborted by selection/context change without restoring stale export UI state.

**Blocked by:** 57

**Category:** bug
**Status:** needs-review

- [x] A Playwright test mounts App with a controlled API boundary.
- [ ] The test starts a pending export cancellation, changes media/editor context, and observes DELETE signal abort.
- [ ] Resolving the deferred cancellation cannot restore the old export job or status in the new App context.
- [ ] Ticket 57 and this ticket accurately record validated completion evidence.
- [ ] `make check` passes.

## Comments

Opened from ticket 57’s residual risk. Tickets 50–57 remain unmerged until this test passes review.
