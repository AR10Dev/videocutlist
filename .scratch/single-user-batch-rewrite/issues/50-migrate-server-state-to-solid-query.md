# 50: Migrate frontend server state to Solid Query

**What to build:** Move media and project reads, project saves, export/detection job polling, cancellation, invalidation, and stale-response protection onto the compatible TanStack Solid Query foundation selected by ticket 49.

**Blocked by:** None

**Category:** enhancement
**Status:** completed

- [x] Media and project reads use query keys and generated OpenAPI response types.
- [x] Project saves and job cancellation use mutations with abort-aware request functions.
- [x] Export and detection polling stops on terminal states and invalidates related queries.
- [x] Stale responses cannot overwrite a newer selection or editor revision.
- [x] Tests cover query cancellation, polling termination, invalidation, and stale-response protection.
- [x] Existing same-origin URL and authentication behavior remains unchanged.

## Comments

- Added Solid Query job queries for export and detection with AbortSignal cancellation, terminal-state polling shutdown, and query cancellation on user cancellation.
- Added polling interval tests; client build, 65 Vitest tests, and Oxlint pass.
- Media and project reads now use Solid Query keys and generated OpenAPI model types; project saves use an abort-aware Solid Query mutation.
- Project and media fetches use QueryClient caching and AbortSignal propagation; export and detection job queries own polling and cancellation.
- Existing revision, selection, and editor-version guards remain as defense against stale writes; query polling tests cover terminal shutdown.
- Validation: `make check` passes (65 client tests); no staged files remain.

