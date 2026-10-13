# Historical triage snapshot

This is pre-migration evidence, not a live queue. Current state and discussion
are in Beads; see [the migration mapping](migration.md). References to ignored
local work boards/handoffs describe the original execution environment.

---

## Claude audit: repository triage

## Basis and limits

Reviewed HEAD `1c6866f86a3511bee7af2fdfd8a409dc96af54d9`, with the current local AGENTS.md instructions. All 25 tickets now contain evidence and disposition under Comments. This pass changes only local tracker documents; no application fixes, integration branch, or commits were made. Existing user changes to AGENTS.md are untouched.

Three read-only reviewers inspected source, tests, and contracts. Their checks were static, not executed tests. Parent execution is listed separately below. The original audit remains unchanged as historical evidence; ticket comments supersede contradicted claims.

## Disposition

| Status | Tickets | Meaning |
|---|---|---|
| ready-for-agent | 04, 06, 07, 08, 09, 11, 12, 13, 16, 17, 22, 24 | Remaining specified work; measurement gates retained |
| needs-triage | 02, 10, 18 | Reproduction, invariant investigation, or hardening justification remains |
| needs-info | None | Earlier policy questions are superseded by maintainer decisions below |
| wontfix | 01, 03, 05, 14, 15, 19, 20, 21, 23, 25 | 01/03/05/15 completed; 14/19/20/21/23/25 declined |

No mandatory blockers were added. Metrics, package renames, and module splits are not prerequisites for independent correctness work.

## Implementation update

Tickets 01, 03, 05, and 15 are completed on integration/claude-audit at 00beb19. Full Go race suite and vet passed; all 538 frontend tests, typecheck, formatting, oxlint and Node regressions passed. Four completed worktrees were removed; integration remains clean. Other tickets are not complete. Details and scope limits are in implementation.md and each completed ticket's Comments.

## Original ready frontier

- **01:** Fix shellcheck exit propagation while checking every script; regression for a non-final failure.
- **03:** Preserve connection-local SQLite settings on replacement connections. Verify driver/path behavior and actual foreign-key enforcement; WAL must remain enabled.
- **08:** Encode valid structured records and safely retain correlated internal causes. Keep public envelopes and non-leakage tests; no automatic global logger migration or arbitrary raw-error logging.
- **09:** Extend the existing isolated metrics registry with bounded pool/finalization observations. Define latency coverage, including initial reads and exhaustion; no new endpoint or config.
- **11:** Select justified static checks individually with manageable findings and regression examples. Evaluation is the task, not enabling every proposed linter.
- **17:** Check the two ignored constructor errors with context and existing resource cleanup; no injection framework for unreachable nil-DB startup cases.
- **22:** Correct package documentation and add missing negative route coverage. No wholesale boundary removal or typed-parameter migration without evidence.

Recommended first fixes **01 and 03** are now completed. Ticket **02** remains a high-priority reproduction, not an approved persistence redesign.

## Executed evidence

1. Ran the actual `make lint` recipe with temporary PATH stubs for unrelated tools and a shellcheck stub failing the first script and passing the last. Both were checked; make returned **0**, confirming masked failure. This does not claim a full lint or real shellcheck run.
2. A temporary Go probe called actual `OpenDatabase` on a temporary file database. Initial connection: `foreign_keys=1`, `busy_timeout=5000`, `journal_mode=wal`. After forcing idle-connection disposal, two replacements each reported `foreign_keys=0`, `busy_timeout=0`, `journal_mode=wal`. Assertions passed; probe and database were removed.
3. Ran the proposed linter set using local golangci-lint **v2.13.1**, matching the CI pin, with no configuration/default checks. It reported **124 findings**: contextcheck 12, errorlint 6, gosec 32, nilerr 5, noctx 18, revive 50, sqlclosecheck 1. Reports include apparent intentional contexts/test-only cases and require individual triage; these are not 124 confirmed defects. Blank-error checking still needs separate evaluation.
4. Ran `TestLegacyDatabaseRequiresExplicitReset`, `TestSchedulerRetriesTerminalTransitionPreservingRunnerResult`, and `TestSchedulerSurfacesExhaustedTerminalTransitionWithoutEmptySuccess` once; all passed. Other packages included in that command had no matching tests. This does not reproduce actual terminal-state connection contention.

Local Go was 1.26.5; module requires 1.26.0 and CI pins 1.26.9. Full CI was not reproduced.

## Important corrections

- **21:** REST deliberately specifies 400 `invalid_interchange` for oversized raw input; automation specifies 413 for its JSON envelope. No domain-rule divergence was demonstrated. Status unification is an intentional API change, not a proven fix.
- **20:** Wiring finishes before scheduler start/admission/serving; affected entry points already reject missing dependencies. No demonstrated half-wired exposure.
- **25:** Pre-Goose databases are already detected with an actionable error and preserved by a passing test. The maintainer subsequently declined legacy upgrade, compatibility, and retention work. Current development supports only the current design; incompatible schemas may require recreation. No actual database deletion is authorized by this decision.
- **15:** The normal page caller already has a 120-second inactivity deadline and sends worker cancellation. A worker-only/orphaned-caller header stall still needs reproduction.
- **16:** The final allocated filename includes an additional suffix; validation must budget it and the extension. Export publication supports Linux/macOS; Windows helper files alone do not establish Windows export support.
- **18:** Modern Go can collect unreferenced tickers, but failed startup with a live caller context may leave cleanup active. Reproduce ownership failure before a lifecycle change; cosmetic ticker replacement is not warranted.
- **10:** Negative accounting was not demonstrated. If its panic were reached while holding the transport mutex, HTTP panic recovery alone would not restore it. Do not silently clamp.

## Earlier decision gates (resolved below)

The questions below describe the initial triage gates, not outstanding maintainer requests.

1. **Authentication (05, 06, 07):** Minimum token policy and compatibility treatment; trusted-proxy explicitness/universal-range policy; actual MCP/proxy exposure and expected traffic; intended preview/MCP concurrency coupling.
2. **Performance (04, 02):** Target storage/filesystems and artifact scale; acceptable download-open and bounded finalization/shutdown latency. Actual contention reproduction and 10,000-record synchronization measurements remain outstanding.
3. **Automation/deployment (12, 13):** Manual vs scheduled real-media checks, cost/runtime/artifact budgets; updater platform/cadence and immutable-pin maintenance; supported container restrictions.
4. **Download/naming (15, 16):** Supported browsers and header timeout policy; reject vs truncate expanded filenames and supported filename budget. Windows expansion is not assumed.
5. **Documentation/compatibility (24, 25):** License, security reporting contact/supported versions, and whether legacy databases exist outside development and require an upgrade commitment. Factual container guidance can be narrowed separately; do not invent ADRs or delete legacy data.

## Approved maintainer defaults

The maintainer approved the recommended defaults, except legacy-database retention, and explicitly allows breaking changes. Each affected ticket has an authoritative Maintainer decision comment.

- **04:** Measure first; change locking only for demonstrated material delay, preserving identity/download lifetimes.
- **05:** Minimum configured token length 32 bytes; generate random secrets with `openssl rand -hex 32`; no short-token compatibility path.
- **06:** Explicit trusted CIDRs and no universal /0; document peer trust and recommend individual addresses; no arbitrary breadth warnings.
- **07:** Account for external MCP exposure; measure before bounded pre-auth admission; keep shared limit policy initially, no speculative settings or credential caching.
- **12:** Manual plus weekly real-media workflow, 30-minute timeout, 14-day artifacts, no uncalibrated performance threshold.
- **13:** Weekly Dependabot, SHA/digest pins, validated dropped capabilities/no-new-privileges; read-only root conditional on successful harness; keep curl.
- **15:** Worker-local 120-second header timeout using existing AbortController APIs; clear on headers/cleanup, no whole-stream deadline.
- **16:** Reject final names over 255 bytes including suffix/extension; no truncation or Windows export expansion.
- **24:** MIT, latest release initially, GitHub private vulnerability reporting (verify enabled before claiming availability), factual documentation, no invented ADRs.
- **25 / general development policy:** Implement the current design as if written for the first time. Replace superseded implementations; no backward-compatibility layers, schema-upgrade work, or legacy-database retention requirement. Incompatible schema changes may require recreating the database. This does not order deletion of existing data or an uninspected wholesale rewrite of initialization infrastructure. Ticket 25 is declined.

Breaking changes must still update current callers, tests, generated clients, and documented contracts together. Security, cancellation, shutdown, atomicity, and current-design correctness remain mandatory. Measurement gates are not waived.

## Remaining validation

No full suite, race suite, browser/real-media run, container harness, 10,000-record benchmark, or authentication-load experiment was performed. Reliability and lifecycle allegations not covered by the explicit probes above remain unconfirmed. Local `.scratch/` tracker files are ignored by Git; they require explicit publication if they must travel with a future branch.


## Finalization update (2026-10-13)

At integration HEAD `182a05d25772b1badedc49691da0d1ae9488267f`, statuses are: 17 retained completed/no-change tickets `wontfix` (01, 03–12 except 02/13 as listed below, 15–18, 22, 24); 6 declined/archived `wontfix` (14, 19, 20, 21, 23, 25); and 2 unfinished `needs-info` (02, 13). Ticket 02 has reproduced initial-read/write contention; the proposed five-second total persistence budget is unapproved. Ticket 13 pins are merged but runtime restrictions remain dirty and unvalidated after Buildah overlay failure; read-only root remains disabled. The integration worktree is clean. See finalization report for evidence paths and validation attribution.
