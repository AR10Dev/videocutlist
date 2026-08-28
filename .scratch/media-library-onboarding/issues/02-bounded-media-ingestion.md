# 02: Keep bounded media import jobs coherent

**What to build:** Cancelling or completing a server-side media import leaves the library in an accurate state and does not retain terminal jobs indefinitely.

**Blocked by:** None

**Category:** bug
**Status:** ready-for-agent

- [ ] Cancelling an import records the job as cancelled without leaving the library in `LibraryFailed`.
- [ ] After cancellation, the library reports the last known usable state or recomputes ready-empty versus ready-with-media.
- [ ] Succeeded, failed, and cancelled imports remain queryable for a documented bounded interval, then leave the in-memory job map.
- [ ] Ownership checks and opaque job IDs remain unchanged while terminal jobs are queryable.
- [ ] Go tests cover cancellation during catalog refresh and terminal-job expiry.

## Comments

The bounded import contract was previously completed. Reopened after the review at `c2dcedf` found that `RefreshMedia` records context cancellation as `LibraryFailed` and terminal entries remain in `MediaUseCase.imports` indefinitely.

Browser clients still receive only opaque job and media IDs; original filesystem paths remain server-side.
