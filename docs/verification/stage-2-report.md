# Stage 2 Verification Report

## Scope

Configurable browser API base URL, authentication policy, safe URL
construction, injected preview requests, and cross-origin regression coverage.

## Terra agents spawned

| Agent ID | Model | Role | Branch | Commit |
|---|---|---|---|---|
| `terra-stage-2-impl-1` | `gpt-5.6-terra` | client implementer | `agent/terra-stage-2-client` | `076e615` |
| `terra-stage-2-test-1` | `gpt-5.6-terra` | test specialist | `agent/terra-stage-2-client-test` | `38a96fb` |
| `terra-stage-2-fix-1` | `gpt-5.6-terra` | E2E remediation | `agent/terra-stage-2-fix-1` | `e15fc1f` |
| `terra-stage-2-verify-1` | `gpt-5.6-terra` | independent verifier | `agent/terra-stage-2-verify-1` | none |
| `terra-stage-2-fix-2` | `gpt-5.6-terra` | URL security remediation | `agent/terra-stage-2-fix-2` | `218a411` |
| `terra-stage-2-verify-2` | `gpt-5.6-terra` | independent re-verifier | `agent/terra-stage-2-verify-2` | none |

## Implemented changes

- Added `ClientConfiguration`, runtime configuration resolution, and one API
  client boundary with none, bearer, and cookie policies.
- Routed metadata, media listing, projects, and preview requests through that
  boundary.
- Changed preview streaming to receive a request closure.
- Added URL/authentication tests and a 5173-to-8787 browser test.
- Hardened decoded path validation against encoded separator traversal.

## Terra verifier findings

### Passed

- The final verifier passed all frozen acceptance criteria, all web/Make
  gates, two Playwright runs, and 17 independent adversarial URL probes.
- All application requests use `api.request`; preview uses an injected
  request callback.

### Failed

- The first verifier rejected encoded-separator traversal. Commit `218a411`
  corrected the defect and added regression coverage.
- The controller's initial candidate gate exposed a stale-status E2E race and
  missing cross-origin diagnostic header exposure. Commit `e15fc1f` corrected
  the fixture without changing product behavior.

### Risks

- URL path validation intentionally decodes once. Double-encoded values remain
  literal data and are rejected by the server's opaque-ID validation when used
  as media identifiers.

## Controller diff inspection

- Files inspected: `web/src/api.ts`, `web/src/App.tsx`,
  `web/src/preview.ts`, both Vitest files, and the Playwright specification.
- Contract changes: only the controller-frozen Stage 2 runtime/API contract.
- Security implications: central credential/header ownership and decoded
  separator traversal rejection.
- Architecture drift: none; no server CORS or dependency changes.
- Unrelated changes: none.

## Commands executed by controller

```bash
npm --prefix web run lint
npm --prefix web test
npm --prefix web run build
npm --prefix web run test:e2e
npm --prefix web run test:e2e
npm --prefix web test -- -t 'rejects a request path'
make check
make test
make smoke
git diff --check 7c6ad51..HEAD
rg -n "fetch\(|['\"]/?api/v1|EDITAPP_CONFIG|createApiClient|streamPreview" web/src web/tests web/playwright
```

The first isolated-cache Make attempts were environment-blocked by restricted
network access and then temporary-space exhaustion. The controller removed
only task-specific Go build caches and reran sequentially with the verified
local module cache; the recorded final results below are successful runs.

## Results

| Check | Result | Evidence |
|---|---|---|
| ESLint | PASS | exit 0 |
| Vitest | PASS | 30/30 |
| TypeScript/Vite build | PASS | 18 modules built |
| Playwright | PASS | 2/2 twice |
| Targeted unsafe paths | PASS | 8/8 |
| `make check` | PASS | Go race, lint, test, and build completed |
| `make test` | PASS | all Go and 30 web tests |
| `make smoke` | PASS | full cached gate completed |
| Diff/search inspection | PASS | no direct application `fetch` or API bypass |

## Acceptance criteria

| Criterion | Result | Evidence |
|---|---|---|
| No hardcoded or same-origin requirement | PASS | runtime base and four URL tests |
| All network calls use the boundary | PASS | source search and interface review |
| Safe URL/prefix/query/encoded ID handling | PASS | 30 tests plus adversarial probes |
| Exact authentication policies | PASS | header, credential, and signal assertions |
| Cross-origin streaming/cancellation | PASS | repeated 5173-to-8787 Playwright |
| Existing UI behavior | PASS | complete browser scenario |
| No unrelated/server/dependency change | PASS | diff inspection |

## Final verdict

`STAGE PASS`

## Controller signature

- Controller session: `/root`
- Date: 2026-07-30
- Integration commit: `2f5a165`
