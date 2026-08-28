# 23: Expose batch export HTTP and source-change failures

**What to build:** Route browser-facing batch export submission, progress, and cancellation through the production batch service and persist changed/missing source failures as `source_changed`.

**Blocked by:** 22

**Category:** bug
**Status:** ready-for-agent

- [ ] HTTP server injects the batch export service and exposes safe batch submit, progress, and cancellation operations.
- [ ] Existing export HTTP flow reaches the batch path instead of legacy export-only service where batch behavior is required.
- [ ] Missing or changed source errors wrap the scheduler `ErrSourceChanged` sentinel and persist `source_changed`.
- [ ] Regression tests cover HTTP batch submission/progress/cancellation and source-change failure code.

## Comments

- Opened from post-merge review of ticket 22. Server construction creates a batch export use case but HTTP API has no dependency or routes and retains the legacy export service; missing media uses a raw error that does not match the scheduler source-change sentinel.
