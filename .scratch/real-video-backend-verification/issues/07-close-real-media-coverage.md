# 07: Close real-media coverage and publish evidence

**What to build:** The assembled suite covers the complete production router, emits the required safe summary, passes repository checks, and leaves default test behavior unchanged.

**Blocked by:** 03, 04, 05, 06

**Category:** enhancement
**Status:** blocked

- [x] All 31 production route kinds (34 method/path variants) are accounted for in the real-media route coverage table, with process checks for health, readiness, static delivery, destinations, settings, and batches.
- [x] The opt-in command emits verbose test evidence, including the accounted route count, without filesystem paths.
- [x] The harness uses temporary directories and process-group cleanup on success and failure.
- [x] `make check`, `make test`, and `make smoke` remain unchanged and do not gain network access.
- [ ] `make test-real-media` passes: the export workflow currently terminates with `job_failed` in the production process (existing issue 05 blocker).
- [x] This ticket records the implementation and validation evidence below.

Implementation evidence (2026-09-03): added `test/realmedia/routes_test.go` with all 31 production route kinds (34 method/path variants) and process endpoint checks; changed `make test-real-media` to use `-v` so compact `t.Log` evidence is published. Fixture acquisition and build passed; the suite reached the real export and failed with `job_failed`. No fixture or generated output was committed.
