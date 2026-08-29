# 51: Complete Solid Query lifecycle migration

**What to build:** Close the remaining Solid Query lifecycle gaps so media navigation, job cancellation, terminal invalidation, and stale-response protection are owned and tested through Solid Query without transient UI regressions.

**Blocked by:** 50

**Category:** bug
**Status:** completed

- [x] Export and detection cancellation use abort-aware Solid Query queries and cancellation.
- [x] Successful cancellation and terminal job updates invalidate related job queries.
- [x] Queued and running detection jobs never display a transient failed status.
- [x] Folder navigation, refresh, and paginated media reads use query keys rather than legacy request controllers.
- [x] Tests exercise query polling termination and stale-response protection.
- [x] Handwritten media, project, destination, and export job response models are replaced by generated OpenAPI schemas where contracts exist.
- [x] `make check` passes.

## Comments

Opened from the ticket 50 review. Migrated folder navigation and pagination to keyed QueryClient fetches, added refresh/cancellation invalidation, and removed the obsolete export model duplicate. Validation: `make check` passes (65 client tests).
