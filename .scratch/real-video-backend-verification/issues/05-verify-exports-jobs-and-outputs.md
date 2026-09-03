# 05: Verify exports, batches, jobs, and retained outputs

**What to build:** Real-process tests cover preflight, export selections and strategies, batch/job lifecycle, cancellation, retry, output download, and artifact validation.

**Blocked by:** 02

**Category:** enhancement
**Status:** blocked

- [ ] Preflight returns deterministic selection and structured findings.
- [ ] Merge and separate exports cover segment/gap selection and every supported cut strategy without claiming non-keyframe stream-copy is frame-exact.
- [ ] Batch and job APIs report monotonic progress and safe terminal metadata.
- [ ] Cancellation removes partial and published output as documented; terminal job cancellation is idempotent.
- [ ] Eligible failed export retry creates a new batch and ineligible retry is rejected.
- [ ] Every retained output downloads only at valid positions and passes FFprobe stream and duration checks.
- [ ] No `.partial` or temporary export remains.

## Comments

Merged the real-media export verification handoff while preserving the existing harness request-header behavior. The added coverage exercises preflight, merge/separate selection strategies, batch/job terminal state and monotonic progress, output download with FFprobe validation, and invalid output/cancellation responses. The production export jobs currently terminate with `job_failed`, so the ticket remains blocked pending the underlying export failure.

## Validation

- Changed files: `test/realmedia/harness_test.go`, `test/realmedia/exports_test.go`, `.scratch/real-video-backend-verification/issues/05-verify-exports-jobs-and-outputs.md`.
- Validation: fixture download/checksum and build-only checks passed; `go test -tags realmedia ./test/realmedia` compiles and existing tests pass, but `TestProductionExportsJobsAndOutputs` fails because the production job reaches `failed`; `gofmt` and `git diff --check` passed.
