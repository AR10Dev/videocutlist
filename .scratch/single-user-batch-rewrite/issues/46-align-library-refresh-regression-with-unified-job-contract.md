# 46: Align library refresh regression with unified-job contract

**What to build:** Update the legacy refresh regression to verify accepted unified scan jobs and failure propagation.

**Blocked by:** 41, 44

**Category:** bug
**Status:** completed

- [ ] The full Go suite passes with the refresh endpoint's accepted-job contract.
- [ ] Tests cover accepted scan response and submission failure without restoring synchronous refresh.

## Comments

- Opened from ticket 44 validation: `api.TestRefreshReturnsNoContentAndPropagatesFailure` still expects the removed synchronous 204 behavior.
