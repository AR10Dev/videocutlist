# 05: Submit immutable batch export snapshots

**What to build:** Batch export submission that snapshots selected project items and creates independently executable queued jobs.

**Blocked by:** 02, 04

**Category:** enhancement
**Status:** completed

- [x] The caller can submit all or selected project-item IDs in project order.
- [x] Every child job stores the project revision, project-item snapshot, media source fingerprint, stream selection, cut strategy, destination, filename, and relevant runtime settings.
- [x] Editing or deleting a project item after submission cannot change the queued job.
- [x] Execution revalidates the source fingerprint and fails with `source_changed` if the original changed or disappeared.
- [x] One child failure does not cancel unrelated children in the same batch.
- [x] Batch cancellation cancels queued children and requests cancellation of running children.
- [x] Batch progress is computed from its child jobs and remains available after restart.
- [x] No job request, result, warning, or log exposes an original-media path.

## Comments

- Added immutable batch export submission over the unified JobsStore. Items are selected in project order, cloned into per-child snapshots with safe media fingerprints and runtime settings, and inserted atomically.
- Added derived batch cancellation/progress operations and source fingerprint validation. Destination IDs and filename templates are guarded so snapshots contain no filesystem paths.
- `make check` passed.
