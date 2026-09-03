# 04: Verify projects, interchange, and detection

**What to build:** Real-process tests cover project persistence and revision control, interchange, and all detection kinds against the trailer.

**Blocked by:** 02

**Category:** enhancement
**Status:** complete

- [x] Project create, read, list pagination, update, and stale-revision rejection preserve the expected state.
- [x] CSV and chapter export/import increment revisions; invalid or out-of-bounds input returns safe 422 without mutation.
- [x] Silence, black, and scene detection jobs reach terminal success through real FFmpeg.
- [x] Returned candidates have correct opaque IDs, source kind, bounded times, and confidence.
- [x] Stale source fingerprint or revision fails safely and does not mutate the project.

## Comments

Merged the real-process project, interchange, and detection coverage handoff while preserving the earlier fixture and harness/media coverage. The test validates project revisions and stale writes, CSV/chapter round trips and invalid input, all three FFmpeg detection kinds, candidate bounds, and stale fingerprint safety.

## Completion evidence

- Changed files: `test/realmedia/projects_detection_test.go`, `.scratch/real-video-backend-verification/issues/04-verify-projects-interchange-and-detection.md`.
- Validation: `go test -tags realmedia -run TestProjectsInterchangeAndDetectionUseProductionProcess -count=1 ./test/realmedia` passed; `gofmt` and `git diff --check` passed; no staged files before commit.
