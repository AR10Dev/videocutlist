# 18: Complete unified job lookup and startup wiring tests

**What to build:** Remove the remaining detection-store lookup from HTTP job retrieval and prove server startup invokes unified recovery.

**Blocked by:** 17

**Category:** bug
**Status:** completed

- [x] HTTP job retrieval uses only the unified job service and preserves the safe detection response contract.
- [x] No production HTTP handler probes the legacy detection store for lookup or cancellation.
- [x] A server startup/wiring test proves unified recovery is invoked.

## Comments

- Opened from post-merge review of ticket 17. Cancellation was unified, but job retrieval still probes `Detection.Get` before `Jobs.Get`; direct store recovery tests do not prove server startup calls recovery.
- Job reads now use only the unified service while retaining detection metadata and candidates in the safe job response. The server integration test starts `run` against a durable running job and verifies startup recovery marks it `interrupted_by_restart` before shutdown. `make check` passed.
