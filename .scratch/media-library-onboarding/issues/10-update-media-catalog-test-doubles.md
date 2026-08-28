# 10: Keep media catalog test doubles aligned

**What to build:** Media import lifecycle tests compile against the safe-folder browse contract after the folder-browser change.

**Blocked by:** 02, 04

**Category:** bug
**Status:** complete

- [x] Every `MediaCatalog` test double implements `Browse` with safe empty behavior.
- [x] `go test -race ./application` passes.

## Comments

Opened during post-merge validation: ticket 04 added `Browse` to `application.MediaCatalog`, while ticket 02's test doubles do not implement it.

Implemented safe empty `Browse` methods on the cancellable and bounded-recovery catalog test doubles. Evidence: `gofmt -w application/services_test.go`, `go test -race ./application` (18 tests passed), and `git diff --check` passed.
