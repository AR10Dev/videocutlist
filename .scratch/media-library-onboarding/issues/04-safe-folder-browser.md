# 04: Restore safe media folder browsing

**What to build:** The folder-tree API and browser navigation work from the library root through nested safe virtual folders without leaking original paths or mixing pages from different folders.

**Blocked by:** None

**Category:** bug
**Status:** ready-for-agent

- [ ] `GET /api/v1/media/tree` returns 200 for the root and valid opaque folder IDs with the real server wiring.
- [ ] The configured media service implements the browse contract directly; the handler does not depend on a runtime assertion that always fails.
- [ ] Activating the library-root control clears the active folder and reloads root folders and media.
- [ ] Refresh clears stale folder and cursor state before loading root results.
- [ ] Pagination appends only results from the folder that produced its cursor.
- [ ] API integration and Playwright tests reproduce the 500 response, return-to-root flow, refresh, and pagination regression.
- [ ] Responses continue to expose only opaque media/folder IDs and approved labels, never original filesystem paths.

## Comments

The original safe-folder feature was previously completed. Reopened after the review at `c2dcedf` reproduced a 500 response from `/api/v1/media/tree`; `application.MediaService` does not expose `Browse`, so the handler's optional `MediaBrowser` assertion fails with the production service. The UI also has no working return-to-root action and retains `activeFolder` across refresh.
