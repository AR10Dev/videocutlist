# 23: Expose batch export HTTP and source-change failures

**What to build:** Route browser-facing batch export submission, progress, and cancellation through the production batch service and persist changed/missing source failures as `source_changed`.

**Blocked by:** 22

**Category:** bug
**Status:** completed

- [x] HTTP server injects the batch export service and exposes safe batch submit, progress, and cancellation operations.
- [x] Existing export HTTP flow reaches the batch path instead of legacy export-only service where batch behavior is required.
- [x] Missing or changed source errors wrap the scheduler `ErrSourceChanged` sentinel and persist `source_changed`.
- [x] Regression tests cover HTTP batch submission/progress/cancellation and source-change failure code.

## Comments

- Opened from post-merge review of ticket 22. Server construction creates a batch export use case but HTTP API has no dependency or routes and retains the legacy export service; missing media uses a raw error that does not match the scheduler source-change sentinel.
- Added production batch export routing on project export submission plus safe batch progress and cancellation endpoints, OpenAPI schemas, item selection input, and focused route/error coverage. `make check` passed.
