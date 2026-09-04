# 06: Verify settings, automation, deployment modes, security, metrics, and recovery

**What to build:** Short-lived real-process runs verify settings and restart persistence, automation, destinations, metrics, authentication/deployment modes, request boundaries, path confinement, redaction, cancellation, and durable restart recovery.

**Blocked by:** 02

**Category:** enhancement
**Status:** complete

- [x] Settings read/update, stale revision, deployment-only mutation rejection, destination redaction, and persistence after restart are proved.
- [x] All automation commands work with bearer auth; missing auth, Origin, malformed/unknown/oversized input, and unsupported commands fail safely.
- [x] Metrics contain suite observations without path or opaque-ID labels.
- [x] Bearer, auth-none loopback, trusted-proxy, and allowed/disallowed CORS behavior are exercised.
- [x] Unknown routes/methods/query keys, malformed IDs/JSON, and oversized bodies return bounded safe errors.
- [x] Escaping symlinks are not indexed or opened, and changing/removing source bytes causes safe source-change failure.
- [x] Restart reconciliation handles running and queued durable jobs as documented; projects, settings, media, and terminal jobs remain readable.
- [x] Responses, headers, metrics, and structured logs contain no temporary or original-media paths.

## Comments

Closure evidence: real-process checks cover settings persistence/stale and deployment-only updates, all supported automation commands plus missing auth/Origin/malformed/unknown/oversized input, metrics and structured-log redaction, bearer and auth-none loopback modes, trusted-proxy inclusion/exclusion, CORS, bounded request validation, symlink confinement, source changes/removal, and running/queued restart reconciliation.

## Validation

- Validation: `make test-real-media` passed with 11 real-process tests and 37 accounted routes (34 API method/path variants plus 3 process/static endpoints). `make check`, `make test`, `make smoke`, and `git diff --check` passed.
