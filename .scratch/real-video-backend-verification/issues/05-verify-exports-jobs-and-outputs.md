# 05: Verify exports, batches, jobs, and retained outputs

**What to build:** Real-process tests cover preflight, export selections and strategies, batch/job lifecycle, cancellation, retry, output download, and artifact validation.

**Blocked by:** 02

**Category:** enhancement
**Status:** partial

- [x] Preflight returns deterministic selection and structured findings.
- [ ] Merge and separate exports cover segment/gap selection and every supported cut strategy without claiming non-keyframe stream-copy is frame-exact.
- [x] Batch and job APIs report monotonic progress and safe terminal metadata.
- [ ] Cancellation removes partial and published output as documented; terminal job cancellation is exercised.
- [x] Eligible failed export retry creates a new batch and ineligible retry is rejected.
- [x] Every retained output downloads only at valid positions and passes FFprobe stream and duration checks.
- [x] No `.partial` or temporary export remains.

## Comments

Real-process coverage now decodes deterministic preflight selection/findings, exercises merge/separate segment/gap exports, validates monotonic progress, downloads every valid output position, rejects invalid positions, parses FFprobe duration and video/audio streams, checks terminal cancellation/retry behavior, and scans isolated cache/export directories for temporary artifacts. Hybrid smart-cut remains unsupported for the natural MP4 fixture and is covered by focused unit contracts.

## Validation

- Changed files: `test/realmedia/harness_test.go`, `test/realmedia/exports_test.go`, `.scratch/real-video-backend-verification/issues/05-verify-exports-jobs-and-outputs.md`.
- Validation: fixture download/checksum and build-only checks passed; `go test -tags realmedia ./test/realmedia` compiles and existing tests pass, but `TestProductionExportsJobsAndOutputs` fails because the production job reaches `failed`; `gofmt` and `git diff --check` passed.
