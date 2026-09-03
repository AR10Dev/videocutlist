# 02: Build the production-process black-box harness

**What to build:** A serial opt-in Go black-box harness builds and controls the production process with isolated storage, real dependencies, bounded polling, safe logs, and an exhaustive route inventory.

**Blocked by:** 01

**Category:** enhancement
**Status:** ready

- [ ] `make test-real-media` acquires the fixture and runs only the real-media suite serially.
- [ ] The suite fails rather than skips when FFmpeg, FFprobe, encoders, or the fixture are unavailable.
- [ ] Each process uses OS-reserved loopback ports and isolated database, media, cache, export, and inspection directories.
- [ ] Startup waits for readiness with a deadline; cleanup terminates the app and child media processes and prints bounded logs on failure.
- [ ] The harness discovers media IDs through HTTP and never exposes original paths.
- [ ] A route coverage table accounts for every route accepted by the production router and fails when routes drift.
