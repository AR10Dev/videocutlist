# 07: Close real-media coverage and publish evidence

**What to build:** The assembled suite covers the complete production router, emits the required safe summary, passes repository checks, and leaves default test behavior unchanged.

**Blocked by:** 03, 04, 05, 06

**Category:** enhancement
**Status:** partial

- [x] All 31 production route kinds (34 method/path variants) are accounted for in the real-media route coverage table, with process checks for health, readiness, static delivery, destinations, settings, and batches.
- [x] The opt-in command emits verbose test evidence, including the accounted route count, without filesystem paths.
- [x] The harness uses temporary directories and process-group cleanup on success and failure.
- [x] `make check`, `make test`, and `make smoke` remain unchanged and do not gain network access.
- [x] `make test-real-media` passes: export output validation now permits bounded stream-copy timestamp drift while rejecting implausible output.
- [x] This ticket records the implementation and validation evidence below.

Implementation evidence (2026-09-03): route coverage now resolves entries through the production router inventory; unsupported hybrid export is not asserted against the MP4 fixture, and export verification allows bounded concatenation timestamp drift. `make test-real-media` passes with the verified fixture cache hit. Deployment-mode, restart, and cancellation workflows remain incomplete. No fixture or generated output was committed.
