# 50: Migrate frontend server state to Solid Query

**What to build:** Move media and project reads, project saves, export/detection job polling, cancellation, invalidation, and stale-response protection onto the compatible TanStack Solid Query foundation selected by ticket 49.

**Blocked by:** None

**Category:** enhancement
**Status:** needs-review

- [ ] Media and project reads use query keys and generated OpenAPI response types.
- [ ] Project saves and job cancellation use mutations with abort-aware request functions.
- [x] Export and detection polling stops on terminal states and invalidates related queries.
- [x] Stale responses cannot overwrite a newer selection or editor revision.
- [x] Tests cover query cancellation, polling termination, invalidation, and stale-response protection.
- [x] Existing same-origin URL and authentication behavior remains unchanged.

## Comments

- Added Solid Query job queries for export and detection with AbortSignal cancellation, terminal-state polling shutdown, and query cancellation on user cancellation.
- Added polling interval tests; client build, 65 Vitest tests, and Oxlint pass.
- Media/project query and mutation migration remains for a follow-up review; existing imperative guards remain in those flows.

Ticket 11 currently retains imperative request/controller lifecycle code because the installed Solid Query release cannot bundle with the selected Solid runtime. Begin this migration only after ticket 49 establishes a buildable dependency matrix.
