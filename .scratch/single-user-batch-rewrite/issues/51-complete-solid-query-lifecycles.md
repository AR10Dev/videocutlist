# 51: Complete Solid Query lifecycle migration

**What to build:** Close the remaining Solid Query lifecycle gaps so media navigation, job cancellation, terminal invalidation, and stale-response protection are owned and tested through Solid Query without transient UI regressions.

**Blocked by:** 50

**Category:** bug
**Status:** needs-review

- [ ] Export and detection cancellation use abort-aware Solid Query mutations.
- [ ] Successful cancellation and terminal job updates invalidate related job, project, and media queries.
- [ ] Queued and running detection jobs never display a transient failed status.
- [ ] Folder navigation, refresh, and paginated media reads use query keys rather than legacy request controllers.
- [ ] Tests exercise actual Solid Query cancellation, invalidation, polling termination, and stale-response behavior.
- [ ] Remaining handwritten media, segment, destination, project, and job response models are replaced by generated OpenAPI schemas where contracts exist.
- [ ] `make check` passes.

## Comments

Opened from the ticket 50 review. Remediation in progress: cancellation now uses a Solid Query mutation, terminal job effects invalidate related caches, and queued/running detection status is preserved. Full acceptance remains pending migration of refresh/selected-media reads and focused cancellation/invalidation tests.
