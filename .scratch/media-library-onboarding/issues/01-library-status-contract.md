# 01: Publish safe media-library status

**What to build:** The media API publishes a library status that lets the browser distinguish configured, scanning, ready-empty, ready-with-media, and failed states without exposing an original-media filesystem path.

**Blocked by:** None

**Category:** enhancement
**Status:** complete

- [x] The response reports a stable state and a user-safe diagnostic message.
- [x] The response never includes an absolute or relative original-media path.
- [x] Contract tests cover every state and reject path leakage.

## Comments

Derived from the empty first-run workspace review.

- Added `GET /api/v1/media/status` with five safe library states and fixed diagnostics.
- Validation: `go test ./application ./protocol/http ./infrastructure/config ./cmd/server`.
