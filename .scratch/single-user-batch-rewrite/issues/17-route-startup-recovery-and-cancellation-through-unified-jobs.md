# 17: Route recovery and cancellation through unified jobs

**What to build:** Complete production adoption of the unified job store for startup recovery and HTTP cancellation.

**Blocked by:** 16

**Category:** bug
**Status:** ready-for-agent

- [ ] Startup invokes unified job recovery so durable running jobs become restart-interrupted according to the shared state machine.
- [ ] HTTP job cancellation uses only the unified job service and does not probe detection-specific storage.
- [ ] Regression tests cover startup recovery and cancellation for unified detection and export jobs.

## Comments

- Opened from post-merge review of ticket 16. Startup still calls only the legacy export store’s recovery, and the HTTP cancellation handler still probes the separate detection store before using the unified service.
