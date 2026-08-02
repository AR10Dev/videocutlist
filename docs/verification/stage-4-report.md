# Stage 4 Verification Report

## Scope

Provider-neutral principals, authenticator adapters, none/bearer/trusted-proxy
modes, authorization gates, and generic principal propagation.

## Terra agents spawned

| Agent ID | Model | Role | Branch | Commit |
|---|---|---|---|---|
| `terra-stage-4-impl-1` | `gpt-5.6-terra` | auth/config implementer | `agent/terra-stage-4-auth` | `ab9a441` |
| `terra-stage-4-impl-2` | `gpt-5.6-terra` | principal/test-fault implementer | `agent/terra-stage-4-principal-test` | `f2177cb` |
| `terra-stage-4-fix-1` | `gpt-5.6-terra` | bearer remediation | `agent/terra-stage-4-fix-1` | `7a59982` |
| `terra-stage-4-verify-1` | `gpt-5.6-terra` | independent verifier | `agent/terra-stage-4-verify-1` | none |
| `terra-stage-4-fix-2` | `gpt-5.6-terra` | contract remediation | `agent/terra-stage-4-fix-2` | `3da53fe` |
| `terra-stage-4-verify-2` | `gpt-5.6-terra` | independent re-verifier | `agent/terra-stage-4-verify-2` | none |

## Implemented changes

- Replaced provider identity types with generic `Principal` and
  `Authenticator` interfaces.
- Added none, constant-time static bearer, and trusted-proxy-context adapters.
- Propagated principals across API/application interfaces and opaque Subject to
  lower ownership/rate keys.
- Added authorization-before-service-call and spoofing regression coverage.

## Terra verifier findings

### Passed

- The final re-verifier passed every auth, authorization, propagation,
  spoofing, contract, race, and Make criterion.

### Failed

- The candidate initially rejected a configured control-free bearer suffix
  containing an internal space; `7a59982` fixed the exact comparison.
- The first verifier found stale Tailscale ownership wording in the runtime
  contract; `3da53fe` changed it to opaque `Principal.Subject` ownership.

### Risks

- OIDC remains an adapter boundary only, as frozen; no speculative dependency
  or partial implementation was added.

## Controller diff inspection

- Files inspected: auth/config/server, API/application services and tests, and
  runtime/OpenAPI contracts.
- Contract changes: frozen Stage 4 provider-neutral authentication contract.
- Security implications: exact bearer ownership, trusted context-only identity,
  and 401/403 before application services.
- Architecture drift: none.
- Unrelated changes: none.

## Commands executed by controller

```bash
gofmt -l <changed Go files>
go vet ./...
go test -race ./...
go test -race ./internal/auth ./test/integration/api -run 'Test(BuiltinAuthenticatorModes|APIAuthenticationModesRejectBeforeServices|PrincipalAllows)' -count=10
make check
make test
make smoke
git diff --check f504544..HEAD
rg -n -i 'Tailscale-User|Tailscale-App-Capabilities|tailscale|tailnet|ts\.net|AuthMode.*(dev|tailscale)|user_login|auth\.(Identity|Capabilities)' cmd internal docs/contracts
```

## Results

| Check | Result | Evidence |
|---|---|---|
| Formatting/vet | PASS | no formatting output; vet exit 0 |
| Full Go race | PASS | all packages |
| Focused auth stress | PASS | ten consecutive runs |
| `make check` | PASS | Go/web lint, race, tests, build |
| `make test` | PASS | all Go and 30 web tests |
| `make smoke` | PASS | full gate |
| Coupling search | PASS | no active provider identity coupling |

## Acceptance criteria

| Criterion | Result | Evidence |
|---|---|---|
| All three authentication modes | PASS | unit/integration mode table |
| Strict constant-time bearer behavior | PASS | source and adversarial tests |
| Generic principal propagation | PASS | interface/diff inspection |
| Capability allow/deny | PASS | unit and API tests |
| Failed auth invokes no services | PASS | zero-call assertions |
| No Tailscale core identity coupling | PASS | scoped search |
| No OIDC/dependency/network drift | PASS | diff inspection |

## Final verdict

`STAGE PASS`

## Controller signature

- Controller session: `/root`
- Date: 2026-08-02
- Integration commit: `4d7cb23`
