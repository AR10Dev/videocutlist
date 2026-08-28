# 13: Complete the feature-module cutover

**What to build:** The final modular-monolith structure, dependency cleanup, contracts, and release validation after all rewrite behavior has moved.

**Blocked by:** 06, 08, 09, 10, 12

**Category:** enhancement
**Status:** blocked

- [ ] Backend behavior lives under `internal/db`, `library`, `projects`, `jobs`, `preview`, `export`, `detection`, `settings`, `httpapi`, and `web`.
- [ ] The old horizontal `domain`, `application`, `protocol`, and pass-through adapter packages have no remaining production callers and are removed.
- [ ] HTTP handlers are split by feature and only translate transport concerns before calling one feature operation.
- [ ] Go runtime dependencies contain SQLite and no router, ORM, dependency-injection, queue, or FFmpeg binding library.
- [ ] The embedded frontend and one-process native/container deployment continue to work.
- [ ] OpenAPI, database schema, runtime contract, recovery runbooks, README, and container examples describe the new single-user batch contracts.
- [ ] `gofmt`, `go vet`, `go test -race ./...`, frontend lint, Vitest, build, Playwright, `make check`, `make test`, and `make smoke` pass.
- [ ] The final diff contains no generated previews, exports, caches, database files, media originals, or secrets.

## Comments
