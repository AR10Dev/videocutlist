# 06: Verify settings, automation, deployment modes, security, metrics, and recovery

**What to build:** Short-lived real-process runs verify settings and restart persistence, automation, destinations, metrics, authentication/deployment modes, request boundaries, path confinement, redaction, cancellation, and durable restart recovery.

**Blocked by:** 02

**Category:** enhancement
**Status:** ready

- [ ] Settings read/update, stale revision, deployment-only mutation rejection, destination redaction, and persistence after restart are proved.
- [ ] All automation commands work with bearer auth; missing auth, Origin, malformed/unknown/oversized input, and unsupported commands fail safely.
- [ ] Metrics contain suite observations without path or opaque-ID labels.
- [ ] Bearer, auth-none loopback, trusted-proxy, and allowed/disallowed CORS behavior are exercised.
- [ ] Unknown routes/methods/query keys, malformed IDs/JSON, and oversized bodies return bounded safe errors.
- [ ] Escaping symlinks are not indexed or opened, and changing/removing source bytes causes safe source-change failure.
- [ ] Restart reconciliation handles running and queued durable jobs as documented; projects, settings, media, and terminal jobs remain readable.
- [ ] Responses, headers, metrics, and structured logs contain no temporary or original-media paths.
