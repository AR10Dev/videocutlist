# 04: Add the bounded local job scheduler

**What to build:** A scheduler inside the Go process that accepts a bounded durable backlog independently from its bounded FFmpeg worker capacity.

**Blocked by:** 03

**Category:** enhancement
**Status:** ready-for-agent

- [ ] Queue capacity and concurrent background-worker limits are separate positive settings.
- [ ] Capacity checking and insertion of every job in a submitted batch occur in one SQLite transaction.
- [ ] A batch that would exceed queue capacity is rejected without creating any child jobs.
- [ ] The scheduler atomically claims queued jobs only when a worker slot is available.
- [ ] Queued jobs remain queued across restart.
- [ ] Running jobs found at startup become failed with `interrupted_by_restart` unless artifact reconciliation has already proved success.
- [ ] Cancellation removes queued work or cancels the running context without changing a terminal job.
- [ ] No automatic retry occurs; retry creates a new job from an explicit user action.
- [ ] Tests cover concurrent submissions, capacity exhaustion, restart recovery, cancellation races, and graceful shutdown.

## Comments
