# 17: Route recovery and cancellation through unified jobs

**What to build:** Complete production adoption of the unified job store for startup recovery and HTTP cancellation.

**Blocked by:** 16

**Category:** bug
**Status:** completed

- [x] Startup invokes unified job recovery so durable running jobs become restart-interrupted according to the shared state machine.
- [x] HTTP job cancellation uses only the unified job service and does not probe detection-specific storage.
- [x] Regression tests cover startup recovery and cancellation for unified detection and export jobs.

## Comments

- Opened from post-merge review of ticket 16. Startup still calls only the legacy export store’s recovery, and the HTTP cancellation handler still probes the separate detection store before using the unified service.
- Server startup now invokes `JobsStore.Recover`; HTTP cancellation calls only the configured unified job service. Store recovery coverage exercises detection and export job kinds, and HTTP coverage verifies detection cancellation is not probed. `make check` passed.
