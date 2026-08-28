# 19: Validate unified job and batch IDs

**What to build:** Enforce opaque job and batch identifier formats at the unified durable-job persistence boundary.

**Blocked by:** 18

**Category:** bug
**Status:** completed

- [x] Unified job creation rejects malformed or arbitrary job IDs and batch IDs.
- [x] Valid opaque job and batch IDs persist successfully.
- [x] Regression tests cover valid and invalid ID inputs.

## Comments

- Opened from post-merge review of ticket 18. `JobsStore.Create` currently accepts any non-empty job and batch ID, despite ticket 03’s opaque-ID contract.
- Enforced the existing HTTP opaque-ID shape (`j_`/`b_` plus 12–64 URL-safe characters) at unified job creation. `make check` passed.
