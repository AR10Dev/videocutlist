# 16: Complete unified-job migration and production adoption

**What to build:** Make the unified durable jobs contract safe for colliding legacy IDs and make production lookup and cancellation use it exclusively.

**Blocked by:** 03

**Category:** bug
**Status:** ready-for-agent

- [ ] Migrating legacy export and detection jobs with the same old ID succeeds and preserves both jobs under distinct opaque unified IDs.
- [ ] Server wiring and job use cases use the unified store for lookup and cancellation rather than separate export and detection stores.
- [ ] Transition tests cover queued cancellation, running failure, restart interruption recovery, and concurrent terminal transitions.

## Comments

- Opened from post-merge review of ticket 03. Legacy export and detection tables used independent ID namespaces, so direct insertion into a shared `jobs.id` can collide. Production wiring still uses separate stores, and transition coverage is incomplete.
