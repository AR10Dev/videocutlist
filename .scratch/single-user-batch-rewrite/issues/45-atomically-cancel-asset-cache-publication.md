# 45: Atomically cancel asset cache publication

**What to build:** Make the asset cache writer lose to cancellation through its final publication boundary.

**Blocked by:** 39

**Category:** bug
**Status:** wontfix

- [x] Cancellation immediately before asset-cache rename leaves no published asset cache entry.
- [x] The regression covers the asset service, not export publication.

## Comments

- Opened after ticket 42 changed export publication rather than the reviewed `infrastructure/assets` cache path.
- Retained as `wontfix` because the implementation and regression coverage are complete.
