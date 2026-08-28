# 04: Add the bounded local job scheduler

**What to build:** A scheduler inside the Go process that accepts a bounded durable backlog independently from its bounded FFmpeg worker capacity.

**Blocked by:** 03

**Category:** enhancement
**Status:** completed

- [x] Queue capacity and concurrent background-worker limits are separate positive settings.
- [x] Capacity checking and insertion of every job in a submitted batch occur in one SQLite transaction.
- [x] A batch that would exceed queue capacity is rejected without creating any child jobs.
- [x] The scheduler atomically claims queued jobs only when a worker slot is available.
- [x] Queued jobs remain queued across restart.
- [x] Running jobs found at startup become failed with `interrupted_by_restart` unless artifact reconciliation has already proved success.
- [x] Cancellation removes queued work or cancels the running context without changing a terminal job.
- [x] No automatic retry occurs; retry creates a new job from an explicit user action.
- [x] Tests cover concurrent submissions, capacity exhaustion, restart recovery, cancellation races, and graceful shutdown.

## Comments

- Added bounded durable batch admission, atomic queued-job claims, cancellable worker execution, and graceful worker shutdown. Running jobs remain covered by the shared startup `Recover` transition; artifact reconciliation remains ticket 06. `make check` passed.
