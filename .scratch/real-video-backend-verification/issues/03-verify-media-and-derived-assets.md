# 03: Verify media and derived assets through HTTP

**What to build:** Real-process tests cover health, readiness, static delivery, media scan/browse/import, preview, thumbnails, and waveform using the verified trailer.

**Blocked by:** 02

**Category:** enhancement
**Status:** complete

- [x] Health, readiness, static app, media status/list/tree/detail, refresh aliases, and import lifecycle routes are exercised.
- [x] Metadata matches FFprobe within documented rounding and responses contain no filesystem paths.
- [ ] Preview boundary clamping, HEAD miss/hit, playable bytes, cache miss-to-hit, conditional requests, cancellation, and partial-file cleanup are proved.
- [x] Thumbnail and waveform payloads validate and cache hits are proved.
- [ ] Scan and import cancellation or documented terminal behavior is exercised with deadlines.

## Comments

Merged the real-process HTTP coverage handoff. The test starts the production process against the verified trailer, validates static/readiness/media metadata and opaque IDs, exercises refresh and import lifecycle routes, probes playable preview and thumbnail bytes with cache behavior, and validates waveform payloads. Cancellation, preview conditional requests, and partial-file cleanup remain outside this handoff's coverage.

## Completion evidence

- Changed files: `test/realmedia/process_test.go`, `test/realmedia/harness_test.go`.
- Validation: `go test -tags realmedia -run TestProductionProcessMediaAndDerivedAssets -count=1 ./test/realmedia` passed with fixture acquisition/checksum verification; `gofmt` and `git diff --check` passed; no staged files before merge.
