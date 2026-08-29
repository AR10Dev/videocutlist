# 45: Atomically cancel asset cache publication

**What to build:** Make the asset cache writer lose to cancellation through its final publication boundary.

**Blocked by:** 39

**Category:** bug
**Status:** completed

- [ ] Cancellation immediately before asset-cache rename leaves no published asset cache entry.
- [ ] The regression covers the asset service, not export publication.

## Comments

- Opened after ticket 42 changed export publication rather than the reviewed `infrastructure/assets` cache path.
