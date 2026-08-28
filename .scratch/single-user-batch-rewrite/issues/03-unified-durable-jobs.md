# 03: Unify durable job persistence

**What to build:** One SQLite-backed jobs module and state machine for export, detection, and library-scan work.

**Blocked by:** 01

**Category:** enhancement
**Status:** ready-for-agent

- [ ] Every job has an opaque ID, batch ID, kind, state, immutable request, optional result, error code, and timestamps.
- [ ] Project and project-item references are optional only for job kinds that do not operate on a project item.
- [ ] Existing export and detection jobs migrate into the unified schema without exposing paths.
- [ ] Allowed transitions are `queued` to `running` or `cancelled`, and `running` to `succeeded`, `failed`, or `cancelled`.
- [ ] Conditional SQL updates prevent cancellation, completion, and failure from overwriting terminal states.
- [ ] Batch progress and state are derived from child jobs rather than stored independently.
- [ ] Job lookup and cancellation use one interface instead of probing separate stores.
- [ ] Tests cover every allowed and rejected transition plus concurrent terminal transitions.

## Comments
