# 22: Wire batch export scheduling and source-change contracts

**What to build:** Make batch export submission and execution a required production scheduler path with correct source-change failures and running-child cancellation.

**Blocked by:** 21

**Category:** bug
**Status:** ready-for-agent

- [ ] Production server wiring constructs the scheduler and routes batch export submission, execution, and cancellation through it.
- [ ] Batch export cannot fall back to direct store insertion or store-only cancellation when scheduler behavior is required.
- [ ] Missing or changed sources cause the persisted child failure code `source_changed`.
- [ ] A regression test proves cancelling a running batch-export child cancels its execution context.

## Comments

- Opened from post-merge review of ticket 21. The new batch-export use case and runner have no production wiring, nil scheduler fallback bypasses required admission/cancellation behavior, raw `source_changed` errors do not match the scheduler sentinel, and cancellation coverage only exercises queued store jobs.
