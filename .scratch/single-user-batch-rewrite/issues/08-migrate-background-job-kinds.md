# 08: Move detection and library scans onto the durable queue

**What to build:** Detection and library-scan workflows implemented as job kinds in the unified scheduler rather than separate stores or in-memory job maps.

**Blocked by:** 04, 07

**Category:** enhancement
**Status:** ready-for-agent

- [ ] Detection jobs store immutable media fingerprints and bounded detector parameters.
- [ ] Detection results contain review candidates and safe metadata only.
- [ ] Library refresh creates a durable scan job and reports per-root results from transactional scans.
- [ ] The in-memory media-import job map and separate detection-job store are removed.
- [ ] One job endpoint returns and cancels export, detection, and scan jobs consistently.
- [ ] Restart, cancellation, and terminal-state behavior match the shared state machine.
- [ ] Existing detection and library browser workflows continue through the unified contract.

## Comments
