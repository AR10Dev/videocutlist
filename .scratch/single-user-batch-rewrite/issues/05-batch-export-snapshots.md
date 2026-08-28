# 05: Submit immutable batch export snapshots

**What to build:** Batch export submission that snapshots selected project items and creates independently executable queued jobs.

**Blocked by:** 02, 04

**Category:** enhancement
**Status:** ready-for-agent

- [ ] The caller can submit all or selected project-item IDs in project order.
- [ ] Every child job stores the project revision, project-item snapshot, media source fingerprint, stream selection, cut strategy, destination, filename, and relevant runtime settings.
- [ ] Editing or deleting a project item after submission cannot change the queued job.
- [ ] Execution revalidates the source fingerprint and fails with `source_changed` if the original changed or disappeared.
- [ ] One child failure does not cancel unrelated children in the same batch.
- [ ] Batch cancellation cancels queued children and requests cancellation of running children.
- [ ] Batch progress is computed from its child jobs and remains available after restart.
- [ ] No job request, result, warning, or log exposes an original-media path.

## Comments
