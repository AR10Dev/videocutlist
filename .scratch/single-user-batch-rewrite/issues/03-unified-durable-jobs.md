# 03: Unify durable job persistence

**What to build:** One SQLite-backed jobs module and state machine for export, detection, and library-scan work.

**Blocked by:** 01

**Category:** enhancement
**Status:** completed

- [x] Every job has an opaque ID, batch ID, kind, state, immutable request, optional result, error code, and timestamps.
- [x] Project and project-item references are optional only for job kinds that do not operate on a project item.
- [x] Existing export and detection jobs migrate into the unified schema without exposing paths.
- [x] Allowed transitions are `queued` to `running` or `cancelled`, and `running` to `succeeded`, `failed`, or `cancelled`.
- [x] Conditional SQL updates prevent cancellation, completion, and failure from overwriting terminal states.
- [x] Batch progress and state are derived from child jobs rather than stored independently.
- [x] Job lookup and cancellation use one interface instead of probing separate stores.
- [x] Tests cover every allowed and rejected transition plus concurrent terminal transitions.

## Comments

- Added the owner-free `jobs` table and `JobsStore` state machine for export, detection, and library scans. Batch state and progress derive from child rows. Legacy export/detection rows migrate into the unified table using their project's first migrated item.
- Retained legacy typed stores only as temporary adapters for the still-unmigrated execution paths; ticket 08 moves those callers onto the shared scheduler. `make check` passed.
