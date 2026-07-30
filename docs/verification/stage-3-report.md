# Stage 3 Verification Report

## Scope

Deny-by-default exact-origin CORS, strict preflight handling, provider-neutral
trusted-proxy parsing, forwarded-header stripping, and server middleware
wiring.

## Terra agents spawned

The environment retained only three persistent explicitly selected Terra
threads. Unique Stage 3 logical assignments were recorded on those separate
instances; two implemented and the third remained read-only.

| Agent ID | Model | Role | Branch | Commit |
|---|---|---|---|---|
| `terra-stage-3-impl-1` | `gpt-5.6-terra` | CORS implementer | `agent/terra-stage-3-cors` | `44df861` |
| `terra-stage-3-impl-2` | `gpt-5.6-terra` | proxy and test/fault implementer | `agent/terra-stage-3-proxy` | `4cda113` |
| `terra-stage-3-fix-1` | `gpt-5.6-terra` | preflight remediation | `agent/terra-stage-3-fix-1` | `ceee280` |
| `terra-stage-3-verify-1` | `gpt-5.6-terra` | independent security verifier | `agent/terra-stage-3-verify-1` | none |

## Implemented changes

- Added strict CORS and preflight middleware.
- Added trusted-proxy CIDR parsing, right-to-left client selection, validated
  forwarded metadata context, and unconditional header stripping.
- Wired CORS outside trusted proxy and the existing mux.
- Added allow/deny/preflight and proxy spoofing/chain tests.

## Terra verifier findings

### Passed

- Final verifier passed every criterion, full race/Make gates, and independent
  multi-header, ordering, spoofing, and chain-limit probes.

### Failed

- The assembled candidate initially omitted two required preflight `Vary`
  values. The controller issued `STAGE FAIL`; `ceee280` added only those
  values, after which independent and controller verification passed.

### Risks

- Stage 3 only transports optional generic identity in request context.
  Authentication consumption remains intentionally deferred to Stage 4.

## Controller diff inspection

- Files inspected: `internal/httpx/cors.go`, `internal/httpx/proxy.go`, their
  tests, and `cmd/server/main.go`.
- Contract changes: controller-frozen runtime CORS/proxy contract only.
- Security implications: untrusted forwarding data is stripped and ignored;
  malformed trusted data fails before downstream execution.
- Architecture drift: none; order is CORS → trusted proxy → mux.
- Unrelated changes: none.

## Commands executed by controller

```bash
gofmt -l internal/httpx/cors.go internal/httpx/proxy.go internal/httpx/cors_test.go internal/httpx/proxy_test.go cmd/server/main.go
go vet ./...
go test -race ./...
go test -race ./internal/httpx -run 'Test(CORS|TrustedProxy)' -count=10
make check
make test
make smoke
git diff --check ecad125..HEAD
rg -n "X-Forwarded|ForwardedInfo|TrustedProxy|Access-Control|Tailscale|tailnet|ts\.net" cmd internal docs/contracts/runtime.md
```

## Results

| Check | Result | Evidence |
|---|---|---|
| Formatting/vet | PASS | no output; exit 0 |
| Full Go race | PASS | all packages |
| Focused security stress | PASS | ten consecutive runs |
| `make check` | PASS | Go/web lint, race, tests, build |
| `make test` | PASS | all Go and 30 web tests |
| `make smoke` | PASS | full gate |
| Diff/search inspection | PASS | no candidate provider-specific rule |

## Acceptance criteria

| Criterion | Result | Evidence |
|---|---|---|
| Empty/default deny and exact allow | PASS | CORS unit and adversarial tests |
| Correct actual/preflight headers | PASS | exact header and Vary assertions |
| Malformed/wildcard/suffix denial | PASS | table-driven tests |
| Untrusted spoof stripping | PASS | context and raw-header assertions |
| Trusted IPv4/IPv6 chain handling | PASS | chain and malformed tests |
| Preflight bypasses services | PASS | downstream and malformed-proxy probe |
| Middleware order | PASS | controller source inspection |
| No provider-specific addition | PASS | diff and search |

## Final verdict

`STAGE PASS`

## Controller signature

- Controller session: `/root`
- Date: 2026-07-30
- Integration commit: `ad79179`
