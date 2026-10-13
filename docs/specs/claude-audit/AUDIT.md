# VideoCutlist (`integration/protocol-v2`) — Code Audit & Remediation Roadmap

**Snapshot reviewed:** `videocutlist-integration-protocol-v2.zip` (231 Go files ≈ 45k LOC incl. tests; 64 TS/TSX files in `web/src`)
**Date:** 2026-10-12
**Method:** static code reading (no build, no test run — see §0)

---

## 0. Scope, method and limits (read this first)

- **Static review only.** The sandbox had no Go toolchain and no network, so I did **not** compile, run tests, run linters, or execute any finding. Every finding below comes from reading code. Findings that depend on runtime behaviour (timing, lock contention) are marked **Needs reproduction**, and the roadmap's first step for each is a failing test or a measurement — not a fix.
- **No git history in the zip**, so I could not diff against `main` and cannot say what *changed* in protocol v2, only what the branch contains.
- **Coverage is partial.** I read the composition root, config, auth, CORS, proxy trust, router, request logging, the job scheduler, DB open/schema/media sync, artifact store, export naming, MCP transport/credentials, the interchange handlers, the service worker and the web API layer, plus build/CI/deploy files. I did **not** deep-read ffmpeg argument construction, the interchange parsers, detection, preview cache internals, or the SolidJS controllers' logic. See Appendix A.
- **Severity scale** (my judgement):
  - **High** — can stall/lose user work or weaken a security boundary under realistic use.
  - **Medium** — real risk under specific config/load, or a meaningful operability/maintainability cost.
  - **Low** — hygiene; fix opportunistically.
- **Correction to my earlier chat summary:** I called the ignored constructor errors in `main.go` a "concrete bug". After reading the constructors, `NewProjectStore`/`NewMediaStore` only fail on a nil `*sql.DB`, which cannot happen there today. It is **latent hygiene (Low)**, not a live bug. The shellcheck-loop issue and token-strength issue stand.

---

## 1. Executive summary

This is a carefully engineered codebase: strict layering enforced by lint scripts, a security-conscious media pipeline (opaque IDs, fd-passed inputs, atomic publish, inode-checked cleanup), an unusually thorough test suite (~24k test LOC vs ~20k source), and real CI hygiene (CodeQL, govulncheck, dependency review, OpenAPI drift check). The issues below are mostly about **what happens under contention and misconfiguration**, plus **observability and documentation gaps** — not careless code.

**The one finding I would act on first (REL-1):** the app uses a **single SQLite connection** (`SetMaxOpenConns(1)`), while the scheduler gives a job's terminal-state write only **100 ms × 3 attempts**, and the media rescan holds that one connection for a whole-root transaction. By reading the code, a finishing export can fail to record its result if a rescan (or any slow query) holds the connection, leaving the job `running` until the next restart. This needs reproduction, but it is cheap to test and the potential impact (losing the outcome of a long export) justifies doing it first.

### Top findings at a glance

| ID | Sev | Title | Effort |
|---|---|---|---|
| REL-1 | **High** | Single DB connection + 100 ms terminal writes + long write transaction | M |
| SEC-1 | Med | Bearer token has no minimum strength | S |
| SEC-2 | Med | `trusted_proxy` mode: any peer in trusted CIDRs is authenticated; no guardrails | S |
| SEC-3 | Med | MCP: unthrottled pre-auth DB lookups; DB write on every authenticated call | M |
| OPS-1 | Med | Hand-built JSON logs; causes of 5xx errors never logged | M |
| CI-1 | Med | `make lint` can silently pass when shellcheck fails | S |
| CI-2 | Med | Linter set is `standard` only (no gosec/noctx/errorlint; blank errors unchecked) | S–M |
| CI-3 | Med | Real-media tests & benchmarks never run in CI | S |
| MNT-1 | Med | 240-line `run()` with two-phase initialization | M |
| DOC-1 | Med | No README / LICENSE / SECURITY.md / CONTEXT.md / ADRs | M |

---

## 2. Strengths to preserve (don't regress these while fixing things)

1. **Boundary discipline.** `AGENTS.md` + `scripts/check-layout.mjs` + `web/scripts/check-boundary.mjs` enforce HTTP → domain → storage layering. One route inventory (`routeDefinitions`) drives mux registration *and* contract-coverage tests.
2. **Media security.** Loopback-by-default bind; `auth=none` refused on non-loopback (both in `config.go` and `NewAuthenticator`); opaque media IDs; sources passed as file descriptors (`fdinput`) to avoid path races; ffmpeg invoked with arg arrays and bounded stderr; exports published by atomic rename; `ArtifactStore.Open` re-checks `os.SameFile`; cleanup uses `Lstat`+`Remove` with inode identity and never recurses.
3. **CORS / Host handling.** Exact-origin allow-list (a literal `*` is ignored), strict preflight validation, `HostGuard` against DNS rebinding, forwarded headers stripped and only honoured from trusted peers (right-most untrusted hop selected).
4. **Credential design (MCP).** 256-bit random secrets stored as SHA-256 verifiers (appropriate for high-entropy secrets), constant-time compare, scopes, expiry, revocation, audit log.
5. **Frontend hygiene.** No `innerHTML`/`eval`; no `any`/`@ts-ignore` outside generated code; the bearer token is held in memory (not `localStorage`) and handed to the download service worker over a `MessageChannel`; the worker validates URL shape, filename and origin before fetching.
6. **Test culture.** Race tests, fault-injection harnesses, fake ffmpeg, real-media tests, Playwright, perf harnesses.
7. **Supply chain basics.** CodeQL, `govulncheck`, dependency-review, `pnpm audit`, and a CI check that fails if `web/src/generated/effect-api.ts` drifts from `api/api.openapi.yaml`.

---

## 3. Findings register

| ID | Sev | Area | Title | Needs repro? | Effort |
|---|---|---|---|---|---|
| REL-1 | High | Reliability | Single DB connection + 100 ms terminal writes + long write tx | Yes | M |
| REL-2 | Med | Reliability | Per-connection PRAGMAs applied once to a pool | Yes | S |
| REL-3 | Low–Med | Reliability | `ArtifactStore` mutex held across disk I/O | Yes | S–M |
| SEC-1 | Med | Security | Bearer token has no minimum strength; validation duplicated | No | S |
| SEC-2 | Med | Security | `trusted_proxy`: no guardrails on CIDR breadth/explicitness | No | S |
| SEC-3 | Med | Security | MCP pre-auth lookups unthrottled; write per authenticated call | Yes | M |
| SEC-4 | Low | Security | `Config` holds the bearer token as a plain `string` | No | S |
| SEC-5 | Low | Security | Download service worker has no response-header timeout | No | S |
| SEC-6 | Low | Robustness | Rendered export filename not length-capped; no Windows reserved-name handling | No | S |
| OPS-1 | Med | Operability | Hand-built JSON logs; 5xx causes never logged | No | M |
| OPS-2 | Low | Operability | No DB pool metrics | No | S |
| OPS-3 | Low | Operability | `panic` on MCP in-flight counter invariant | No | S |
| CI-1 | Med | CI | Shellcheck loop masks failures | No | S |
| CI-2 | Med | CI | Linter set too narrow | No | S–M |
| CI-3 | Med | CI | Real-media tests/benchmarks not in CI | No | S |
| CI-4 | Low–Med | Supply chain | No automated dep updates; actions pinned by tag; unpinned base image; compose not hardened | No | S–M |
| MNT-1 | Med | Maintainability | `run()` composition root: 240 lines, two-phase init | No | M |
| MNT-2 | Low–Med | Maintainability | Package ≠ directory name (`db`→`store`, `settings`→`config`); `runtime` shadows stdlib | No | S–M |
| MNT-3 | Low | Maintainability | Duplicated interchange logic; inconsistent oversize-body status | No | S |
| MNT-4 | Low | Maintainability | `httpx` pass-through (131 call sites); stringly-typed route resource | No | S |
| MNT-5 | Low | Maintainability | Very large files (`credentials.go`, `transport.go`, `export.go`) | No | M |
| MNT-6 | Low | Maintainability | Ignored constructor errors in `main.go` (latent) | No | S |
| MNT-7 | Low | Maintainability | `time.Tick` goroutine in `main.go` | No | S |
| DOC-1 | Med | Docs | README / LICENSE / SECURITY.md / CONTEXT.md / ADRs absent | No | M |
| DOC-2 | Low | Docs | No-upgrade-path for pre-baseline DBs documented only in a code comment | No | S |

---

## 4. Detailed findings

### REL-1 — Single DB connection + 100 ms terminal writes + long write transaction  *(High, needs reproduction)*

**Evidence**
- `internal/db/database.go`: `db.SetMaxOpenConns(1)` — every query, read or write, from every subsystem shares one connection.
- `internal/jobs/scheduler.go` (lines ~21–23): `terminalTransitionAttempts = 3`, `terminalTransitionTimeout = 100 * time.Millisecond`, `terminalTransitionBackoff = 10 * time.Millisecond`. `persistTerminal` gives each attempt a fresh 100 ms context; `finalize` then just logs `job_terminal_failure` and returns.
- `internal/db/media.go` `Sync`: one transaction for a whole root — an `UPDATE` of all rows, then per-record `json.Marshal` + upsert **inside** the transaction (up to `MediaMaxFiles`, default 10,000), then folder upserts.
- `internal/mcp/credentials.go` `TouchLastUsed`: a DB write on every authenticated MCP request and tool call.
- `internal/db/jobs.go` `RecoverRunningJobs`: on next start, any `running` job is marked `failed` / `interrupted_by_restart`.

**Why it matters.** With one connection, a context-bound call waits in the pool queue while another holds the connection. If a rescan transaction (or a slow list/browse query) holds it for more than ~100 ms, a completing job's terminal write can time out three times and give up. The job then stays `running` in the database until the next restart, even though the work finished. Whether the already-published export file is adopted on restart depends on `ArtifactStore.Reconcile`, which I did not trace to the end. The same contention can make `/ready` (a DB ping) slow or failing and stall SSE streams.

**Recommended fix (in this order — stop as soon as the numbers are good)**
1. **Measure first** (see OPS-2): export `sql.DB.Stats()` wait count/duration; add a counter for `job_terminal_failure` and a histogram for terminal-write latency.
2. **Make terminal persistence resilient.** A terminal write is the most important write in the system. Replace "3 × 100 ms" with retry-with-exponential-backoff (e.g. 50 ms → 2 s cap) up to a generous deadline (e.g. 2 minutes) or until a hard shutdown, and keep the existing "don't rerun the runner" semantics.
3. **Shorten the `Sync` transaction.** Marshal metadata and build folder rows *before* `BeginTx`; use a prepared statement for the upsert. Re-measure.
4. **If still needed:** make the rescan not hold the writer for its whole duration — add a `scan_generation` column (migration `00002`), upsert in batches stamped with the new generation, then flip availability with one short `UPDATE ... WHERE root_alias=? AND generation < ?`. This preserves the "successful scan is authoritative" semantic without a long transaction.
5. **If contention remains:** split pools — one writer connection and a small read pool opened read-only (WAL permits concurrent readers). Stores would take the appropriate handle per method.

**Verify.** Add `TestFinalizeSurvivesLongWriteTransaction`: hold a write transaction for ~500 ms while a fake runner completes; assert the job reaches `succeeded`. Add a benchmark using the existing `internal/db/media_bench_test.go` for `Sync` with 10k records, before/after.

---

### REL-2 — Per-connection PRAGMAs applied once to a pool  *(Medium, needs reproduction)*

**Evidence.** `OpenDatabase` runs `PRAGMA foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=5000` via `db.ExecContext`. `foreign_keys` and `busy_timeout` are per-connection settings. With a pool of one this works until `database/sql` discards the connection (e.g. after a driver error) and opens a replacement, which would **not** have those PRAGMAs.

**Fix.** Set them in the DSN so every new connection gets them (the `modernc.org/sqlite` driver supports `_pragma=` query parameters — confirm against the v1.59.0 docs):
```go
q := url.Values{}
q.Add("_pragma", "foreign_keys(1)")
q.Add("_pragma", "busy_timeout(5000)")
q.Add("_pragma", "journal_mode(WAL)")
dsn := (&url.URL{Scheme: "file", Opaque: path, RawQuery: q.Encode()}).String()
```
**Verify.** Test that forces a new connection (`db.SetMaxIdleConns(0)` then two sequential queries) and asserts `PRAGMA foreign_keys` returns 1 on each.

---

### REL-3 — `ArtifactStore` mutex held across disk I/O  *(Low–Medium, needs reproduction)*

**Evidence.** `internal/export/artifacts.go`: `Cleanup` (every 15 min) holds `s.mu` while reading manifests and removing files for *every* job; `Open` holds it across `os.Open`, `Stat`, two `EvalSymlinks` and `Stat`; `Remove` holds it during file removal. Download `Open` calls therefore queue behind a cleanup sweep.

**Fix.** Snapshot the work list under the lock, release it, do file I/O, then re-lock to apply results (re-check the entry still exists). Keep the `active` counter protocol so `Cleanup` never removes a streaming file.
**Verify.** Existing artifact tests plus a test that `Open` completes while a fake slow `Cleanup` is mid-sweep.

---

### SEC-1 — Bearer token has no minimum strength; validation duplicated  *(Medium)*

**Evidence.** `internal/settings/config.go` (bearer branch) and `internal/httpapi/auth.go` (`validToken`) only require "non-empty and no control characters". A one-character token is accepted. This token is the sole gate for any non-loopback deployment (the Docker image defaults to `0.0.0.0` + `bearer`). The check exists in two places.

**Fix.** Require a minimum (suggest ≥ 32 bytes) at startup, in one shared validator used by both `config` and `NewAuthenticator`; add `openssl rand -base64 32` to the example env file and docs. Optionally support `VIDEOCUTLIST_BEARER_TOKEN_FILE` so the secret needn't live in the environment. The header-parsing expression in `Authenticate` is also hard to read; `strings.CutPrefix` on a case-folded scheme is clearer.
**Verify.** Table tests: empty, 1 char, 31 bytes (reject), 32 bytes (accept), control chars (reject).

---

### SEC-2 — `trusted_proxy`: no guardrails on CIDR breadth/explicitness  *(Medium)*

**Evidence.** In `trusted_proxy` mode `Authenticate` returns success iff `GetForwardedInfo(ctx).Trusted`, i.e. the transport peer is inside `VIDEOCUTLIST_TRUSTED_PROXY_CIDRS`. The default is `127.0.0.0/8,::1/128`, so any local process on the host is "authenticated". Nothing prevents `0.0.0.0/0` or `::/0` (which would authenticate everyone), and the CIDR list need not be set explicitly in this mode.

**Fix.** In `trusted_proxy` mode: require the CIDR variable to be set explicitly (no silent loopback default), reject prefix length 0, and log a startup warning for CIDRs broader than, say, /16 (IPv4) or /48 (IPv6). Document the "any local process is trusted" consequence prominently.
**Verify.** Config tests for each rejected/warned case.

---

### SEC-3 — MCP: unthrottled pre-auth lookups; write on every authenticated call  *(Medium, needs reproduction; MCP is off by default)*

**Evidence.** `internal/mcp/transport.go` `ServeHTTP` (lines ~329–343): the bearer token is authenticated (a DB read via `getByTokenIdentifier`, then a conditional write via `TouchLastUsed`) **before** `allowRequest` rate-limits per credential. Unknown or invalid tokens are never rate-limited, and each valid token with a known identifier costs a read + write on the single DB connection (see REL-1). `AuthorizeCredential` also calls `TouchLastUsed` before each tool invocation.

**Fix.**
1. Add a cheap **pre-auth, per-client-IP** limiter using `RequestInfo.ClientIP` (already plumbed from `TrustedProxy`), applied before `Credentials.Authenticate`.
2. **Coalesce `last_used_at` writes** (e.g. at most one per credential per minute, tracked in memory). Keep the *read-side* `activeAt` check on every call so expiry and revocation still take effect immediately — only the timestamp write is coalesced. (The conditional write currently doubles as a revocation race-closer; confirm with a test that revocation remains effective within one request.)
3. `main.go` passes `cfg.PreviewGlobalLimit` as MCP `MaxConcurrentRequests`; this looks like accidental coupling — give MCP its own setting or document the intent.

**Verify.** Load test (the repo's `test/performance` harness) with 1k invalid-token requests/s while a fake job completes; assert job terminal latency stays within budget.

---

### SEC-4 — `Config` holds the bearer token as a plain `string`  *(Low)*
Any `%+v`/`%#v` of `Config` (a debugging line, a panic dump) would print the secret. Introduce a small `type Secret string` with `String()`/`GoString()`/`LogValue()` returning `[redacted]`, and use it for `BearerToken`.

### SEC-5 — Download service worker has no response-header timeout  *(Low)*
`web/public/download-sw.js` aborts only on user cancel or the 30 s post-`ready` expiry. If the upstream `fetch` never returns headers, `event.waitUntil(lifetime)` holds the worker until the browser kills it. Add `AbortSignal.timeout(...)` (or `AbortSignal.any`) for the header phase.

### SEC-6 — Rendered export filename: no length cap; no reserved names  *(Low)*
`RenderTemplate` (`internal/export/destinations.go`) caps the *template* at 160 chars but not the *rendered* name; `{source}` can expand a long (multi-byte) filename past 255 bytes and fail late at publish time with `ENAMETOOLONG`. Cap the rendered name (truncate the stem, preserve the extension) and, because Windows build files exist, reject device names (`CON`, `NUL`, `COM1`…) on that platform.

---

### OPS-1 — Hand-built JSON logs; 5xx causes never logged  *(Medium)*

**Evidence.** No `log/slog` anywhere. Three `Printf` call sites build JSON by hand with `%q` (`main.go`, `scheduler.go`, `httpx.go`); `%q` emits Go escapes (e.g. `\x00`) that are not valid JSON. The request logger in `api.go` uses `json.Marshal` correctly but records only `error_category` — the wrapped cause of an internal error is dropped (`internalError(w, id)` takes no error). `AGENTS.md` asks for structured logs with request ID and error category.

**Fix.**
1. Adopt `slog.NewJSONHandler(os.Stdout, ...)`; pass `*slog.Logger` through constructors (replacing `*log.Logger`).
2. Change `internalError(w, id)` → `internalError(w, id, err)`; log `err` with `request_id`, `method`, `route` at ERROR. Keep the **public** envelope unchanged (no internals leaked to clients).
3. Replace the three hand-built lines with `logger.Info/Error(..., slog.String(...))`.

**Verify.** Test that a handler returning an internal error emits one log record containing `request_id` and the cause, and that the HTTP body contains neither.

### OPS-2 — No DB pool metrics  *(Low)*
Export `db.Stats()` (`WaitCount`, `WaitDuration`, `InUse`, `OpenConnections`) through the existing Prometheus registry. This is the cheapest way to confirm or dismiss REL-1 in production.

### OPS-3 — `panic` on MCP in-flight counter invariant  *(Low)*
`transport.go:833` panics if `inFlight < 0`. `net/http` recovers handler panics (logging a stack and dropping the connection), so this is survivable, but a counter bug becomes a failed request. Prefer: log at ERROR with session ID, clamp to 0, increment a metric.

---

### CI-1 — Shellcheck loop masks failures  *(Medium)*
`Makefile` `lint`: `for file in $(SHELL_FILES); do shellcheck "$$file"; done`. A shell `for` loop exits with the status of its **last** iteration, and make runs recipes without `set -e`, so an earlier failing script is ignored if the last one passes. (`shfmt -d` is fine.)
**Fix:** `shellcheck $(SHELL_FILES)`. **Verify:** temporarily break the first script; `make lint` must fail.

### CI-2 — Linter set too narrow  *(Medium)*
`.golangci.yml` uses `default: standard` only. Suggested additions (introduce with a baseline so existing code doesn't block merges):
```yaml
version: "2"
linters:
  default: standard
  enable:
    - gosec
    - noctx
    - bodyclose
    - errorlint
    - contextcheck
    - sqlclosecheck
    - rowserrcheck
    - nilerr
    - revive          # package naming; enable the directory-mismatch rule if your pinned version supports it
  settings:
    errcheck:
      check-blank: true   # would have flagged `projectStore, _ := ...`
formatters:
  enable:
    - gofmt
```
Expect an initial noise burst; triage per linter, one PR each.

### CI-3 — Real-media tests/benchmarks not in CI  *(Medium)*
`AGENTS.md` says to run `make test-real-media` for production media workflow changes, but `ci.yml` runs only `check` and `e2e`. Add a scheduled (nightly) workflow running `make test-real-media` and `make benchmark-backend`, uploading results as artifacts, so regressions are caught without slowing every PR.

### CI-4 — Supply-chain and deployment hardening  *(Low–Medium)*
- No `dependabot.yml`/`renovate.json`, while all JS dependencies are exact-pinned — pins without update automation drift. Add Dependabot/Renovate for `gomod`, `npm` (pnpm lockfiles), `github-actions`, `docker`.
- Actions are pinned to version **tags** (`actions/checkout@v7.0.1`, …); pin to commit SHAs (with the tag in a comment) and let the update bot maintain them.
- `deployments/containers/Dockerfile`: final stage uses unpinned `debian:bookworm-slim`; consider digest pinning. `curl` is installed solely for `HEALTHCHECK`; a tiny `--healthcheck` flag on the binary removes that dependency.
- `compose.yaml`: consider `read_only: true` (+ `tmpfs: /tmp` if needed), `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`. Validate with `make test-podman`.

---

### MNT-1 — `run()` composition root: 240 lines, two-phase init  *(Medium)*
**Evidence.** `cmd/videocutlist/main.go` wires ~40 collaborators in one function and patches fields after construction: `batchExports.Scheduler = scheduler`, `mediaImportService.Scheduler = scheduler`, `detectionService.Scheduler, detectionService.UnifiedJobs = scheduler, unifiedJobs`. Objects can exist half-wired (nil `Scheduler`) with no validation, contradicting "pass dependencies through constructors" and "keep application logic out of the entry point".
**Fix.** Extract `internal/app` with `Build(ctx, cfg) (*App, error)` and `(*App).Close(ctx) error`. Resolve the scheduler↔use-case cycle with a small consumer-owned interface or a constructor that takes a `func() Scheduler`. `main` becomes: load config → `app.Build` → serve → `Close`.
**Verify.** A smoke test that builds the app against a temp dir and `:0` listener, and a test that each use-case constructor rejects a nil dependency.

### MNT-2 — Package ≠ directory name  *(Low–Medium)*
`internal/db` declares `package store`; `internal/settings` declares `package config`; `internal/runtime` shadows the stdlib. This forces aliases (`exporter`, `jobqueue`, `librarymedia`, `settingsmodel`) in `main.go`. Rename directories to match packages (`internal/store`, `internal/config`) and `internal/runtime` → `internal/runtimecfg` (or similar). Pure mechanical PR; do it **before** MNT-1 to keep diffs readable.

### MNT-3 — Duplicated interchange logic; inconsistent oversize-body status  *(Low)*
`automation` (`project.import`/`project.export`) re-implements the logic of `importInterchange`/`exportInterchange` despite a comment saying it reuses the canonical path. Extract one function used by both. Also: `ReadJSON` and the interchange import use `io.ReadAll(io.LimitReader(...))` rather than `http.MaxBytesReader`; oversize interchange input returns **400** while `automation` returns **413 `body_too_large`**. `AGENTS.md` defines status conventions — pick one and document it. *This is contract-visible: update `api.openapi.yaml`, regenerate `effect-api.ts`, and check the web client's handling.*

### MNT-4 — `httpx` pass-through; stringly-typed route resource  *(Low)*
`var httpx boundary` only forwards to package functions (131 call sites) and the file's package comment says "Package httpx" while the package is `httpapi`. Remove the indirection mechanically. `routeResource` encodes multiple values into one string (`"id:format"`, `"id:position"`) later split with `SplitN`; a small typed `routeParams` struct would remove that fragility.

### MNT-5 — Very large files  *(Low)*
`mcp/credentials.go` (1130 lines), `mcp/transport.go` (1015), `export/export.go` (978), `export/artifacts.go` (882). Split by responsibility (e.g. credentials: generate / verify / scope normalization / persistence; transport: admission / sessions / rate limits / shutdown). Several web controllers are 600–800 lines — split only when next touched, by feature concern, per `AGENTS.md`.

### MNT-6 / MNT-7 — Latent hygiene  *(Low)*
`main.go:86,95` ignore constructor errors (see correction in §0; `check-blank` in CI-2 would catch this class). `main.go:147` uses `time.Tick`; prefer `time.NewTicker` with `defer Stop()` for clarity (leak is benign on modern Go, but linters flag it).

---

### DOC-1 — Missing project documentation  *(Medium)*
The zip has no README, LICENSE, SECURITY.md, `CONTEXT.md` or `docs/adr/`, although `AGENTS.md` refers to the last two. (If they exist on `main` but not this branch, merge them in.) Minimum set:
- **README:** what it is, quick start (`make run`), config reference (generate the table from `config.go`), auth modes and when each is safe, MCP overview, deployment (compose/podman).
- **SECURITY.md:** supported versions, how to report, the threat model summary (loopback default, token model, trust of reverse proxy).
- **LICENSE:** choose one explicitly.
- **CONTEXT.md + ADRs:** at least *ADR-0001 Protocol v2* (versioned `/api/v2` and `/media/v2`, idempotency keys, SSE job events, MCP proposal flow) and *ADR-0002 SQLite single-writer and its limits* (ties directly to REL-1).

### DOC-2 — Upgrade policy for pre-baseline databases  *(Low)*
`OpenDatabase`'s comment says development databases from before the Goose baseline must be reset. That is a fine decision, but it should be in release notes/README and, ideally, detected at startup with a clear error rather than a migration failure.

---

## 5. Roadmap

Effort key: **S** ≤ ½ day · **M** 1–3 days · **L** 3–7 days. Each PR follows `AGENTS.md`: focused, regression test included, `make smoke` + `go test -race ./...` + `pnpm --dir web run format:check` before handoff, and OpenAPI/`effect-api.ts` regenerated for any contract change.

### Phase 0 — Quick wins & safety nets (Day 1–2, ≈ 1 day total)
Goal: stop silent CI gaps and close cheap security holes.
- [ ] **CI-1** fix shellcheck invocation *(S)* — PR 1
- [ ] **SEC-1** minimum bearer-token length + single shared validator + env example update *(S)* — PR 2
- [ ] **SEC-2** `trusted_proxy` guardrails (explicit CIDRs, reject `/0`, warn on broad ranges) *(S)* — PR 3
- [ ] **MNT-6/7** check `NewProjectStore`/`NewMediaStore` errors; `time.NewTicker` *(S)* — PR 4
- [ ] **CI-2** add linters behind a baseline (`new-from-rev`/exclusions) *(S)* — PR 5 (then burn down per linter in later PRs)

**Exit criteria:** `make lint` fails on a deliberately broken shell script; startup rejects weak tokens and `0.0.0.0/0` proxy trust; CI green.

### Phase 1 — Reliability core (Week 1)
Goal: confirm or dismiss REL-1, then harden the DB layer based on evidence.
- [ ] **OPS-2** DB pool metrics + terminal-failure counter + terminal-write latency histogram *(S)* — PR 6 (**do first; it's the measuring stick**)
- [ ] **REL-1a** write `TestFinalizeSurvivesLongWriteTransaction` and a `Sync` 10k-row benchmark; record baseline *(M)* — PR 7
- [ ] **REL-1b** resilient terminal persistence (backoff to a generous deadline) *(S–M)* — PR 8
- [ ] **REL-2** PRAGMAs via DSN + reconnect test *(S)* — PR 9
- [ ] **REL-1c** shorten `Sync` transaction (pre-marshal, prepared statement); re-benchmark *(S–M)* — PR 10
- [ ] **Decision gate:** if metrics still show writer contention → **REL-1d** `scan_generation` migration, then **REL-1e** read/write pool split *(L, only if needed)*
- [ ] **REL-3** narrow `ArtifactStore` lock scope *(S–M)* — PR 11

**Exit criteria:** the new test passes; `Sync` benchmark improved or documented as acceptable; `db_wait_seconds_total` visible and sane under `make benchmark-backend`.

### Phase 2 — Observability (Week 2)
- [ ] **OPS-1** migrate to `slog` (mechanical PR: logger type + constructors) *(M)* — PR 12
- [ ] **OPS-1** `internalError(w, id, err)` logs causes with `request_id` *(S–M)* — PR 13
- [ ] **OPS-3** replace MCP `panic` with log + clamp + metric *(S)* — PR 14
- [ ] **SEC-4** `Secret` type with redaction *(S)* — PR 15

**Exit criteria:** every 5xx in a test run has a matching log record with cause and request ID; response bodies unchanged.

### Phase 3 — MCP hardening (Weeks 3–4)
- [ ] **SEC-3** pre-auth per-IP limiter *(M)* — PR 16
- [ ] **SEC-3** coalesce `last_used_at` writes while keeping per-call revocation/expiry check *(M)* — PR 17
- [ ] **SEC-3** own concurrency setting for MCP instead of `PreviewGlobalLimit` *(S)* — PR 18
- [ ] **MNT-5** split `mcp/credentials.go` and `mcp/transport.go` by responsibility *(M)* — PR 19–20 (pure moves, no behaviour change)

**Exit criteria:** invalid-token flood does not delay job completion in the perf harness; revocation takes effect within one request (test).

### Phase 4 — Structure & maintainability (Weeks 4–6)
Order matters: rename first, then extract.
- [ ] **MNT-2** rename directories/packages to match *(S–M)* — PR 21
- [ ] **MNT-1** `internal/app` composition package; eliminate post-construction field patching *(M)* — PR 22
- [ ] **MNT-3** unify automation/REST interchange logic; pick one oversize-body status (contract change) *(S–M)* — PR 23
- [ ] **MNT-4** remove `httpx` indirection (mechanical); typed `routeParams` *(S–M)* — PR 24
- [ ] **SEC-5 / SEC-6** SW header timeout; filename length cap & reserved names *(S)* — PR 25–26
- [ ] **MNT-5** (opportunistic) split large web controllers when next touched

### Phase 5 — CI, supply chain & documentation (parallelizable; start Week 1)
- [ ] **CI-3** nightly workflow: real-media tests + backend benchmarks *(S)*
- [ ] **CI-4** Dependabot/Renovate; SHA-pin actions; digest-pin base image; compose hardening; `--healthcheck` flag *(S–M)*
- [ ] **DOC-1** README, SECURITY.md, LICENSE, CONTEXT.md, ADR-0001 (protocol v2), ADR-0002 (SQLite single-writer) *(M)*
- [ ] **DOC-2** release-notes entry + friendly startup error for pre-baseline DBs *(S)*

### Dependency graph (what must precede what)
```
OPS-2 ──► REL-1a ──► REL-1b ──► REL-1c ──► (gate) ──► REL-1d/e
                └──► REL-2
OPS-1 (slog) ──► OPS-1 (error causes)         MNT-2 ──► MNT-1
CI-2 baseline ──► per-linter burn-down        SEC-3 ──► MNT-5 (MCP split)
```

---

## 6. Risks of the remediation itself

| Risk | Where | Mitigation |
|---|---|---|
| Chunked/generation-based scan changes "authoritative scan" semantics | REL-1d | Only if measurements demand it; property test that availability flags equal a single-transaction result |
| Read/write pool split introduces visibility/ordering surprises | REL-1e | Keep behind the decision gate; run full `-race` suite and `test/realmedia` |
| Coalescing `last_used_at` weakens revocation timing | SEC-3 | Keep the per-call read-side `activeAt` check; add a revocation-latency test |
| `slog` migration is a wide mechanical diff | OPS-1 | Land logger-type change alone; no behavioural edits in the same PR |
| Status-code unification is client-visible | MNT-3 | Update OpenAPI, regenerate `effect-api.ts`, run Playwright `access`/`interchange` specs |
| New linters create a wall of findings | CI-2 | Baseline + one linter per PR |

---

## 7. Open questions for the maintainer

1. **Hardware target.** Do you expect SD cards / NAS / spinning disks? That determines how seriously to treat REL-1 (slow `fsync` makes the 100 ms budget much tighter).
2. **Is MCP ever exposed beyond loopback/your tailnet?** If yes, SEC-3 moves to High.
3. **Is `trusted_proxy` used in production?** If yes, SEC-2 moves to High.
4. **Windows support:** real target, or only buildable? (Affects SEC-6 and the `terminate_windows.go`/`publish_other.go` test burden.)
5. **Upgrade story:** are there v1 databases in the wild, or is the Goose baseline a deliberate clean break?
6. **Licensing intent** for the repo (DOC-1).

---

## Appendix A — Review coverage

| Area | Depth |
|---|---|
| `cmd/videocutlist/main.go`, `Makefile`, `.golangci.yml`, CI workflows, Dockerfile, compose, `AGENTS.md` | Read in full |
| `internal/settings/config.go` (first ~260 lines), `internal/httpapi/{auth,cors,proxy,httpx,router}.go`, request logging in `api.go` | Read |
| `internal/db/{database,jobs (partial),media (Sync)}.go`, `migrations/00001_schema.sql` | Read |
| `internal/jobs/scheduler.go` (submit, run loop, terminal transitions) | Read |
| `internal/export/{artifacts (cleanup/open/remove),destinations (naming)}.go`, `capabilities.go` | Read |
| `internal/mcp/{transport (ServeHTTP, sessions, rates),credentials (generate/authenticate/touch)}.go` | Read |
| `internal/httpapi/interchange_handlers.go`, `web/public/download-sw.js`, `web/src/api.ts` (head), `web/package.json` | Read |
| Grep sweeps: `exec.Command`, `context.Background`, `panic`, SQL string building, `innerHTML`/`eval`, browser storage | Done |
| ffmpeg argument construction, interchange parsers, detection, preview cache/manager, library index/scan, SolidJS controllers/components, e2e specs, `api.openapi.yaml` | **Not reviewed** (skimmed names/sizes only) |
| Anything requiring execution (tests, `go vet`, `golangci-lint`, `govulncheck`, benchmarks, Playwright) | **Not run** |

## Appendix B — Quick-win checklist (≈ 1 day)

- [ ] `Makefile`: `shellcheck $(SHELL_FILES)` (CI-1)
- [ ] Bearer token ≥ 32 bytes, one shared validator (SEC-1)
- [ ] `trusted_proxy`: explicit CIDRs, reject `/0` (SEC-2)
- [ ] Handle errors from `NewProjectStore` / `NewMediaStore` (MNT-6)
- [ ] `golangci`: `errcheck.check-blank: true` + `gosec`, `noctx`, `errorlint` behind a baseline (CI-2)
- [ ] Export `sql.DB.Stats()` to Prometheus (OPS-2)
- [ ] Add `dependabot.yml` (CI-4)
- [ ] Add a minimal README + SECURITY.md (DOC-1)