# 21: Complete batch export admission, execution, and cancellation

**What to build:** Route batch exports through the bounded scheduler and ensure execution validates immutable source snapshots and batch cancellation reaches running work.

**Blocked by:** 05

**Category:** bug
**Status:** completed

- [x] Batch export admission uses one atomic scheduler-backed capacity check and child-job insertion.
- [x] Export execution decodes the stored snapshot, validates the current source fingerprint, and fails the child with `source_changed` when it differs or is unavailable.
- [x] Batch cancellation terminally cancels queued children and requests cancellation of running execution contexts.
- [x] Regression tests cover capacity rejection, changed source execution failure, and running batch-child cancellation.

## Comments

- Opened from post-merge review of ticket 05. Submission inserts directly into `JobsStore.CreateBatch`, bypassing queue capacity; snapshot validation has no production execution caller; and store-level batch cancellation cannot reach scheduler contexts for running child jobs.
- Routed configured batch export admission and cancellation through `Scheduler`, added the queued snapshot runner seam with source fingerprint revalidation and `source_changed` propagation, and added capacity/source regression tests. `make check` passed.
