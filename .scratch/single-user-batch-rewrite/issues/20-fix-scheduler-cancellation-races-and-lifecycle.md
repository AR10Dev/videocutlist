# 20: Fix scheduler cancellation races and lifecycle safety

**What to build:** Ensure a cancelled running job cannot begin execution and make the scheduler lifecycle and race coverage match its public contract.

**Blocked by:** 04

**Category:** bug
**Status:** completed

- [x] A cancellation racing with worker claim prevents the runner from executing after the job becomes cancelled.
- [x] Concurrent submission, claiming, and cancellation races are covered by regression tests.
- [x] Repeated scheduler start or shutdown calls are safe and do not add workers or panic.

## Comments

- Opened from post-merge review of ticket 04. A worker can claim a job before registering its cancel function, allowing a concurrent cancellation to persist terminal state but still execute the runner; lifecycle calls are not idempotent and required race tests are missing.
- Reopened after follow-up review: the runner invocation remains outside the final cancellation synchronization, so cancellation may still become terminal before invocation; existing tests only cancel after the runner starts and do not force the claim-to-invocation gap or concurrent submit/claim/cancel races.
- Reopened again: the previous fix marks execution started under the mutex but unlocks before actually invoking the runner. Cancellation can still persist terminal cancellation in that gap and the runner then executes. The test seam must target this final unlock-to-invocation boundary.
- Reopened a third time: no lock-only handoff can make arbitrary synchronous runner invocation and concurrent cancellation atomic without holding the mutex for runner duration. For running jobs, cancellation must request context cancellation without terminally transitioning state; the worker owns the terminal transition after the runner returns. Queued cancellation remains terminal immediately. This keeps a runner from executing after the stored state is terminal and preserves cancellability.
- Added an explicit final invocation gate. Cancellation that transitions a registered-but-unacknowledged job marks it cancelled; the gate then skips the runner. A successful gate acknowledgement linearizes execution before arbitrary runner code without holding the scheduler mutex during that code. `make check` passed.
- Registered a running job before the start boundary and atomically marks it started under the scheduler mutex. Cancellation at the deterministic pre-start barrier cancels the context and skips runner invocation; concurrent submit, claim, and cancellation coverage was added. `make check` passed.
- Serialized cancellation with runner registration, checked the durable state before execution, and made start/shutdown idempotent. Added cancellation and lifecycle concurrency tests. `make check` passed.
- Running cancellation now requests only context cancellation; the worker transitions to cancelled after runner return. Queued and claimed-but-unregistered jobs still become terminal immediately. Deterministic handoff and concurrent submit/claim/cancel tests cover the boundary.
