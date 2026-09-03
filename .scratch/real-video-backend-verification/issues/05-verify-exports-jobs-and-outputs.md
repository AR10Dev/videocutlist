# 05: Verify exports, batches, jobs, and retained outputs

**What to build:** Real-process tests cover preflight, export selections and strategies, batch/job lifecycle, cancellation, retry, output download, and artifact validation.

**Blocked by:** 02

**Category:** enhancement
**Status:** complete

- [x] Preflight returns deterministic selection and structured findings.
- [x] Merge and separate exports cover segment/gap selection and every supported cut strategy without claiming non-keyframe stream-copy is frame-exact.
- [x] Batch and job APIs report monotonic progress and safe terminal metadata.
- [x] Cancellation removes partial and published output as documented; terminal job cancellation is exercised.
- [x] Eligible failed export retry creates a new batch and ineligible retry is rejected.
- [x] Every retained output downloads only at valid positions and passes FFprobe stream and duration checks.
- [x] No `.partial` or temporary export remains.

## Comments

Closure evidence: real-process coverage decodes deterministic preflight selection/findings, exercises merge/separate segment/gap exports, and covers stream-copy, precise re-encode, and hybrid smart-cut. The natural MP4 hybrid case is an expected safe terminal failure with retry eligibility; generated-fixture integration tests cover hybrid success and fallback warnings. Tests validate monotonic progress, output positions, FFprobe duration/video/audio streams, cancellation/retry behavior, and absence of partial/temp artifacts. Stream-copy assertions retain the documented non-keyframe warning and do not claim frame exactness.

## Validation

- Changed files: `test/realmedia/harness_test.go`, `test/realmedia/exports_test.go`, `.scratch/real-video-backend-verification/issues/05-verify-exports-jobs-and-outputs.md`.
- Validation: `make test-real-media` passed (11 real-process tests; route summary 37 accounted routes), including export preflight, strategies, cancellation, retries, output downloads and FFprobe checks; `make check`, `make test`, `make smoke`, `gofmt`, and `git diff --check` passed.
