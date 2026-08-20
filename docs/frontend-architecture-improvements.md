# Frontend architecture improvements

## Finding: detection state crosses editor contexts (medium, high confidence)

- **Finding:** media selection, project load, and new project invalidate save/export state but leave detection polling, its timer, and candidate/status signals alive. A stale response can repopulate the UI after the context changes.
- **Minimal plan:** add one `clearDetectionContext()` seam beside `clearExportContext()` that aborts the active request, clears its timer, advances the generation, and clears detection UI state. Call it for media selection, project load, new project, and component cleanup. Add a browser regression that changes media while a detection poll is deferred.
- **Implementation:** implemented the helper and wired all context reset paths; added the deferred-poll regression.
- **Verification:** run frontend lint, unit tests, build, and the Playwright suite.

## Deliberately not selected

The broader controller extraction, generic job runner, response decoders, stream-selection model, and canvas resize seam were not implemented in this pass: the health review identified only stale detection state as a demonstrated blocker, while those refactors would widen scope without an equally concrete regression in the current acceptance target.
