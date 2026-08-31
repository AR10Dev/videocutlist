# 51: Complete Solid Query lifecycle migration

**What to build:** Close the remaining Solid Query lifecycle gaps so media navigation, job cancellation, terminal invalidation, and stale-response protection are owned and tested through Solid Query without transient UI regressions.

**Blocked by:** 50

**Category:** bug
**Status:** completed

- [x] Export and detection cancellation use abort-aware Solid Query mutations.
- [x] Successful cancellation and terminal job updates invalidate related job, project, and media queries.
- [x] Queued and running detection jobs never display a transient failed status.
- [x] Folder navigation, refresh, and paginated media reads use query keys rather than legacy request controllers.
- [x] Tests exercise actual Solid Query cancellation, invalidation, polling termination, and stale-response behavior.
- [x] Remaining handwritten media, segment, destination, project, and job response models are replaced by generated OpenAPI schemas where contracts exist.
- [x] `make check` passes.

## Comments

Opened from the ticket 50 review. Completed remediation: refresh and selected-media reads now use Solid Query, cancellation uses a Solid Query mutation, terminal jobs invalidate related caches, and focused QueryClient lifecycle tests cover cancellation, invalidation, polling termination, and stale-response protection. Validation: `make check` passes.
