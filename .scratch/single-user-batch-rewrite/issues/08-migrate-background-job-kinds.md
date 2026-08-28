# 08: Move detection and library scans onto the durable queue

**What to build:** Detection and library-scan workflows implemented as job kinds in the unified scheduler rather than separate stores or in-memory job maps.

**Blocked by:** 04, 07

**Category:** enhancement
**Status:** blocked

- [x] Detection jobs store immutable detector request parameters and project/media references.
- [x] Detection results contain review candidates and safe metadata only.
- [x] Library refresh creates a durable scan job and reports per-root results from transactional scans.
- [x] Production detection and media-refresh workflows use the unified scheduler and job store.
- [x] One job endpoint returns and cancels export, detection, and scan jobs consistently.
- [x] Restart, cancellation, and terminal-state behavior match the shared state machine.
- [x] Existing detection and library browser workflows continue through the unified contract.

## Comments

- Added unified scheduler dispatch for detection and library-scan jobs, with durable status/cancellation via `JobsStore` and production wiring in `cmd/server`.
- Legacy store/map compatibility remains only for existing unit-test callers; production no longer constructs or uses those paths. `make check` passed.
