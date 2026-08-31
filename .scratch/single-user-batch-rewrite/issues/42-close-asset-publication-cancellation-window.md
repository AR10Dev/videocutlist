# 42: Close asset publication cancellation window

**What to build:** Prevent asset cache publication after cancellation through the final atomic publish boundary.

**Blocked by:** 39

**Category:** bug
**Status:** wontfix

- [x] Cancellation immediately before publication leaves no asset cache entry.
- [x] Regression coverage exercises cancellation after temporary output preparation.

## Comments

- Opened from review of ticket 39: the final rename can still publish after cancellation.
- Retained as `wontfix`: the branch implementation changed export publication, so it must not merge. Ticket 45 fixed and tested the reviewed asset-cache path.
