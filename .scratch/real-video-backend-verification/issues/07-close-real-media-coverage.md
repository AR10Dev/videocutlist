# 07: Close real-media coverage and publish evidence

**What to build:** The assembled suite covers the complete production router, emits the required safe summary, passes repository checks, and leaves default test behavior unchanged.

**Blocked by:** 03, 04, 05, 06

**Category:** enhancement
**Status:** ready

- [ ] Every production route has a successful or expected lifecycle case, with rejection/cancellation checks at trust boundaries and destructive operations.
- [ ] The passing command prints checksum/media, build, route count, project/batch/job, cache, output, restart, and cancellation evidence without paths.
- [ ] Temporary files and child processes are removed on success and failure.
- [ ] `make check`, `make test`, and `make smoke` remain deterministic and do not gain network access unless explicitly opted in.
- [ ] `make test-real-media`, `make check`, `make test`, and `make smoke` pass in their required environments.
- [ ] Spec and ticket status/comments record completion evidence.
