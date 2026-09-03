# 07: Close real-media coverage and publish evidence

**What to build:** The assembled suite covers the complete production router, emits the required safe summary, passes repository checks, and leaves default test behavior unchanged.

**Blocked by:** 03, 04, 05, 06

**Category:** enhancement
**Status:** complete

- [x] All 31 production route kinds (34 method/path variants) are accounted for in the real-media route coverage table, with process checks for health, readiness, static delivery, destinations, settings, and batches.
- [x] The opt-in command emits verbose test evidence, including the accounted route count, without filesystem paths.
- [x] The harness uses temporary directories and process-group cleanup on success and failure.
- [x] `make check`, `make test`, and `make smoke` remain unchanged and do not gain network access.
- [x] `make test-real-media` passes: export output validation now permits bounded stream-copy timestamp drift while rejecting implausible output.
- [x] This ticket records the implementation and validation evidence below.

Completion evidence: runtime route accounting records every helper-sent request and verifies all 31 production route kinds (34 API method/path variants) plus health, ready, and static process endpoints; deleting a request leaves the route uncovered. The 11 real-process tests cover deployment security, cancellation, restart reconciliation, exports, and derived assets. The natural MP4 hybrid case is an expected safe failure with retry eligibility; generated-fixture tests cover hybrid success/fallback. Stream-copy checks retain the documented non-keyframe warning and do not claim frame-exactness. `make test-real-media`, `make check`, `make test`, and `make smoke` passed. No fixture, generated output, cache, database, or worktree file is tracked.
