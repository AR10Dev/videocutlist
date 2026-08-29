# 41: Finish unified library-scan execution and results

**What to build:** Make unified scan jobs the only production scan path and expose their persisted root results.

**Blocked by:** None

**Category:** bug
**Status:** completed

- [ ] Unified job retrieval maps persisted safe per-root scan results into its public response.
- [ ] HTTP and server scan triggers submit unified jobs rather than calling refresh directly.
- [ ] Regression tests cover the unified execution and result path.

## Comments

- Opened from post-merge review of ticket 38. Unified job responses omit root results, while server and HTTP paths still invoke refresh directly.
- Completed with follow-up tickets 44 and 46.
