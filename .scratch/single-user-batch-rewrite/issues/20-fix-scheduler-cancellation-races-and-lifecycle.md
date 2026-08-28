# 20: Fix scheduler cancellation races and lifecycle safety

**What to build:** Ensure a cancelled running job cannot begin execution and make the scheduler lifecycle and race coverage match its public contract.

**Blocked by:** 04

**Category:** bug
**Status:** ready-for-agent

- [ ] A cancellation racing with worker claim prevents the runner from executing after the job becomes cancelled.
- [ ] Concurrent submission, claiming, and cancellation races are covered by regression tests.
- [ ] Repeated scheduler start or shutdown calls are safe and do not add workers or panic.

## Comments

- Opened from post-merge review of ticket 04. A worker can claim a job before registering its cancel function, allowing a concurrent cancellation to persist terminal state but still execute the runner; lifecycle calls are not idempotent and required race tests are missing.
