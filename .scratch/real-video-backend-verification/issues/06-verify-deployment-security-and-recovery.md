# 06: Verify settings, automation, deployment modes, security, metrics, and recovery

**What to build:** Short-lived real-process runs verify settings and restart persistence, automation, destinations, metrics, authentication/deployment modes, request boundaries, path confinement, redaction, cancellation, and durable restart recovery.

**Blocked by:** 02

**Category:** enhancement
**Status:** blocked

- [ ] Settings read/update, stale revision, deployment-only mutation rejection, destination redaction, and persistence after restart are proved.
- [ ] All automation commands work with bearer auth; missing auth, Origin, malformed/unknown/oversized input, and unsupported commands fail safely.
- [ ] Metrics contain suite observations without path or opaque-ID labels.
- [ ] Bearer, auth-none loopback, trusted-proxy, and allowed/disallowed CORS behavior are exercised.
- [ ] Unknown routes/methods/query keys, malformed IDs/JSON, and oversized bodies return bounded safe errors.
- [ ] Escaping symlinks are not indexed or opened, and changing/removing source bytes causes safe source-change failure.
- [ ] Restart reconciliation handles running and queued durable jobs as documented; projects, settings, media, and terminal jobs remain readable.
- [ ] Responses, headers, metrics, and structured logs contain no temporary or original-media paths.

## Comments

Merged the real-process security verification handoff while preserving existing media and derived-asset coverage. Added production-process checks for bearer authentication, unsafe routes and IDs, disallowed automation origins, metrics redaction, and embedded frontend startup; malformed automation commands now return bounded 422 errors. The ticket remains blocked because deployment modes, settings/restart recovery, symlink/source-change handling, and durable-job recovery coverage are not yet complete.

## Validation

- Changed files: `Makefile`, `internal/httpapi/interchange_handlers.go`, `internal/httpapi/routes_test.go`, `test/realmedia/harness_test.go`, `test/realmedia/process_test.go`.
- `go test ./internal/httpapi` passes. The full realmedia package compiles; its pre-existing export test reaches `failed` batch state and fails at `exports_test.go:129`.
- Handoff `e9457fa62bdca262aed436185952cf6965e3dd00` was cherry-picked as `f689642`.
