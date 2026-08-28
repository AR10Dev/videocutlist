# 04: Restore safe media folder browsing

**What to build:** The folder-tree API and browser navigation work from the library root through nested safe virtual folders without leaking original paths or mixing pages from different folders.

**Blocked by:** None

**Category:** bug
**Status:** complete

- [x] `GET /api/v1/media/tree` returns 200 for the root and valid opaque folder IDs with the real server wiring.
- [x] The configured media service implements the browse contract directly; the handler does not depend on a runtime assertion that always fails.
- [x] Activating the library-root control clears the active folder and reloads root folders and media.
- [x] Refresh clears stale folder and cursor state before loading root results.
- [x] Pagination appends only results from the folder that produced its cursor.
- [x] API integration and Playwright tests reproduce the 500 response, return-to-root flow, refresh, and pagination regression.
- [x] Responses continue to expose only opaque media/folder IDs and approved labels, never original filesystem paths.

## Comments

Implemented safe folder browsing wiring and navigation. `application.MediaService` now exposes `Browse` directly, the HTTP handler calls it without a failing optional assertion, and root browsing handles empty `folderId` while preserving opaque IDs. The client root control and refresh clear folder/cursor state and reload the tree; pagination uses the captured folder request and ignores stale responses.

Evidence: `gofmt -w protocol/http/routes_test.go`, `go test ./protocol/http ./application` (69 passed), and `git diff --check` passed. Added production handler dispatch coverage for opaque folder/cursor queries and Playwright coverage for root navigation, refresh status, and folder pagination. Client checks remain unavailable because dependencies are not installed in this worktree.
