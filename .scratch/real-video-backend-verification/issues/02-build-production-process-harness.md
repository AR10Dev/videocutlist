# 02: Build the production-process black-box harness

**What to build:** A serial opt-in Go black-box harness builds and controls the production process with isolated storage, real dependencies, bounded polling, safe logs, and an exhaustive route inventory.

**Blocked by:** 01

**Category:** enhancement
**Status:** complete

- [x] `make test-real-media` acquires the fixture and runs only the real-media suite serially.
- [x] The suite fails rather than skips when FFmpeg, FFprobe, encoders, or the fixture are unavailable.
- [x] Each process uses OS-reserved loopback ports and isolated database, media, cache, export, and inspection directories.
- [x] Startup waits for readiness with a deadline; cleanup terminates the app and child media processes and prints bounded logs on failure.
- [x] The harness discovers media IDs through HTTP and never exposes original paths.
- [x] A route coverage table accounts for every route accepted by the production router and fails when routes drift.

**Completion evidence:**

- Changed files: `Makefile`, `internal/httpapi/routes_test.go`, `test/realmedia/harness_test.go`, `test/realmedia/process_test.go`.
- Validation: `make test-real-media` passed with the verified fixture cache hit; `go test ./internal/httpapi` passed (66 tests); the real-media process started and indexed the fixture successfully.
- The harness resolves repository-relative fixture/build paths, uses isolated temporary storage and a reserved loopback port, waits for readiness, and bounds failure logs; no media originals are tracked.
