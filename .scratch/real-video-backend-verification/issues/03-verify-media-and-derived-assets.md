# 03: Verify media and derived assets through HTTP

**What to build:** Real-process tests cover health, readiness, static delivery, media scan/browse/import, preview, thumbnails, and waveform using the verified trailer.

**Blocked by:** 02

**Category:** enhancement
**Status:** complete

- [x] Health, readiness, static app, media status/list/tree/detail, refresh aliases, and import lifecycle routes are exercised.
- [x] Metadata matches FFprobe within documented rounding and responses contain no filesystem paths.
- [x] Preview boundary clamping, HEAD miss/hit, playable bytes, cache miss-to-hit, conditional requests, cancellation, and partial-file cleanup are proved.
- [x] Thumbnail and waveform payloads validate and cache hits are proved.
- [x] Scan and import cancellation or documented terminal behavior is exercised with deadlines.

## Comments

Closure evidence: the production-process test starts against the verified trailer, validates static/readiness/media metadata and opaque IDs, exercises refresh aliases and import cancellation polling, probes playable preview bytes and boundary clamping, proves HEAD/cache miss-to-hit and conditional responses, and validates thumbnail/waveform payloads and cache validators. Cancellation cleanup is checked for incomplete cache artifacts.

## Completion evidence

- Changed files: `test/realmedia/process_test.go`, `test/realmedia/harness_test.go`.
- Validation: `make test-real-media` passed (11 real-process tests; route summary 37 accounted routes: 34 API variants plus 3 process/static endpoints), as did `make check`, `make test`, and `make smoke`; `git diff --check` passed.
