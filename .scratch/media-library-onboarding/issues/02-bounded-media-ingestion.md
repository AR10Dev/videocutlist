# 02: Keep bounded media import jobs coherent

**What to build:** Cancelling or completing a server-side media import leaves the library in an accurate state and does not retain terminal jobs indefinitely.

**Blocked by:** None

**Category:** bug
**Status:** done

- [x] Cancelling an import records the job as cancelled without leaving the library in `LibraryFailed`.
- [x] After cancellation, the library reports the last known usable state or recomputes ready-empty versus ready-with-media.
- [x] Succeeded, failed, and cancelled imports remain queryable for a documented bounded interval, then leave the in-memory job map.
- [x] Ownership checks and opaque job IDs remain unchanged while terminal jobs are queryable.
- [x] Go tests cover cancellation during catalog refresh and terminal-job expiry.

## Comments

The bounded import contract was previously completed. Reopened after the review at `c2dcedf` found that `RefreshMedia` records context cancellation as `LibraryFailed` and terminal entries remain in `MediaUseCase.imports` indefinitely.

Browser clients still receive only opaque job and media IDs; original filesystem paths remain server-side.

Implementation evidence: `application/services.go` restores a usable library state on context cancellation with a one-second recovery deadline, expires terminal import entries after the documented one-minute retention window, and guards restoration with refresh generations so an older cancellation cannot overwrite a newer refresh result. Focused tests in `application/services_test.go` cover bounded cancellation recovery, concurrent refresh failure protection, cancellation during catalog refresh, and terminal-job expiry. Validation: `gofmt -w application/services.go application/services_test.go`; `go test ./application` (passed, 17 tests); `git diff --check` (passed).
