# 38: Complete unified library-scan result cutover

**What to build:** Return persisted per-root scan results through unified jobs and remove the legacy in-memory import path.

**Blocked by:** None

**Category:** bug
**Status:** completed

- [ ] Unified library-scan job retrieval includes persisted safe per-root results.
- [ ] Production code has no in-memory import map or fallback scan execution path.
- [ ] Regression tests prove durable unified retrieval and removed legacy execution.

## Comments

- Opened from post-merge review of tickets 32 and 35. Root results are not mapped from unified job results, and the in-memory import compatibility path remains reachable.
- Merged. The in-memory import fallback was removed, but ticket 41 covers unified result mapping and remaining direct refresh triggers.
