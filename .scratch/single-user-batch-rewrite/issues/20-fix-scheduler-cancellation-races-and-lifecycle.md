# 20: Fix scheduler cancellation races and lifecycle safety

**What to build:** Ensure a cancelled running job cannot begin execution and make the scheduler lifecycle and race coverage match its public contract.

**Blocked by:** 04

**Category:** bug
**Status:** ready-for-agent

- [ ] A cancellation racing with worker claim prevents the runner from executing after the job becomes cancelled.
- [ ] Concurrent submission, claiming, and cancellation races are covered by regression tests.
- [x] Repeated scheduler start or shutdown calls are safe and do not add workers or panic.

## Comments

- Opened from post-merge review of ticket 04. A worker can claim a job before registering its cancel function, allowing a concurrent cancellation to persist terminal state but still execute the runner; lifecycle calls are not idempotent and required race tests are missing.
- Reopened after follow-up review: the runner invocation remains outside the final cancellation synchronization, so cancellation may still become terminal before invocation; existing tests only cancel after the runner starts and do not force the claim-to-invocation gap or concurrent submit/claim/cancel races.
- Serialized cancellation with runner registration, checked the durable state before execution, and made start/shutdown idempotent. Added cancellation and lifecycle concurrency tests. `make check` passed.
