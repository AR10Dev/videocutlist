# 03: Verify the export download lifecycle

**What to build:** Executable evidence that only the owning principal can download a valid, available export and that crafted or stale requests fail without leaking paths.

**Blocked by:** None (can start immediately)

**Category:** enhancement
**Status:** completed

- [x] Another principal, unknown output positions, and traversal-shaped inputs are rejected.
- [x] Expired and cancelled exports cannot be downloaded.
- [x] Durable destinations follow the documented download rules.
- [x] Successful downloads return the expected headers.
- [x] No response exposes an internal filesystem path.

## Comments

- Added API coverage for authorization, route validation, headers, and path-safe failures; added adapter coverage for persisted ownership, expiry, cancellation, and destination-kind enforcement.
- Validation: `rtk go test ./test/integration/api ./infrastructure/adapters -count=1`; `rtk go test -race ./...`.
