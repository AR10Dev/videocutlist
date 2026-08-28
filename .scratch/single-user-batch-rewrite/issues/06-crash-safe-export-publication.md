# 06: Reconcile crash-safe export publication

**What to build:** An export artifact lifecycle that can determine the correct job result after a crash between filesystem publication and the final database transition.

**Blocked by:** 05

**Category:** bug
**Status:** needs-review

- [x] Each export writes into a job-owned temporary location and records enough safe metadata to reconcile that job only.
- [x] FFprobe validation succeeds before publication.
- [x] Successful publication uses atomic rename wherever the destination filesystem permits it.
- [x] Startup recovery recognizes and validates a fully published job-owned output before marking that job succeeded.
- [x] Invalid, incomplete, or unowned artifacts are never reported as successful and are cleaned up safely.
- [x] Recovery cannot overwrite or delete an unrelated user file.
- [x] Download, archive, and source-adjacent destinations follow an explicit tested reconciliation policy.
- [x] Tests inject interruption before validation, before rename, after rename, and before the success transition.

## Comments

- Added atomic job-owned manifests before export publication, FFprobe-backed startup reconciliation, safe cleanup of invalid owned outputs, and scheduler integration that removes manifests only after durable success.
- Recovery scans configured download/archive roots and source-adjacent media roots, never follows symlinked directories, and only touches basenames listed by a valid job manifest.
- Added reconciliation tests for successful publication recovery, invalid artifact cleanup, job isolation, and unrelated-file preservation. `make check` passed.
