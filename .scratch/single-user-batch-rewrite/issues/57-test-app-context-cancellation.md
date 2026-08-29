# 57: Test application context cancellation isolation

**What to build:** Exercise the App’s own context-cleanup and cancellation completion paths against a deferred DELETE, prove stale export UI state cannot be restored, and clear cancellation controllers during unmount.

**Blocked by:** 56

**Category:** bug
**Status:** needs-review

- [ ] App-level test triggers a pending export cancellation, invokes the App media-selection/context cleanup path, and observes the DELETE AbortSignal abort.
- [ ] After the deferred cancellation settles, the App test proves old export job/status state is not written into the new context.
- [ ] Unmount aborts and clears export and detection cancellation controllers.
- [ ] Replace static-ID stale-response coverage with an application/query lifecycle assertion.
- [ ] Reconcile tickets 50–56 statuses and checklists only with verified criteria.
- [ ] `make check` passes.

## Comments

Opened from ticket 56 review. Application unmount now routes through shared cancellation cleanup, aborting and clearing both export and detection controllers. Added focused cleanup coverage. Validation: `make check` passes. Full mounted-App deferred DELETE coverage remains a review consideration.
