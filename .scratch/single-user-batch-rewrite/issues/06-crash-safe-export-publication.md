# 06: Reconcile crash-safe export publication

**What to build:** An export artifact lifecycle that can determine the correct job result after a crash between filesystem publication and the final database transition.

**Blocked by:** 05

**Category:** bug
**Status:** ready-for-agent

- [ ] Each export writes into a job-owned temporary location and records enough safe metadata to reconcile that job only.
- [ ] FFprobe validation succeeds before publication.
- [ ] Successful publication uses atomic rename wherever the destination filesystem permits it.
- [ ] Startup recovery recognizes and validates a fully published job-owned output before marking that job succeeded.
- [ ] Invalid, incomplete, or unowned artifacts are never reported as successful and are cleaned up safely.
- [ ] Recovery cannot overwrite or delete an unrelated user file.
- [ ] Download, archive, and source-adjacent destinations follow an explicit tested reconciliation policy.
- [ ] Tests inject interruption before validation, before rename, after rename, and before the success transition.

## Comments
