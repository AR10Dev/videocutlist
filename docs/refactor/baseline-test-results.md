# Stage 0 baseline test results

**Recorded:** 2026-07-30 UTC
**Revision:** `5f6effa632ff483b128c19061141328e032b540e`
**Worktree:** `agent/terra-stage-0-baseline`

## Tooling and environment

| Item | Result |
|---|---|
| Go | `go version go1.26.5 linux/amd64` from `/tmp/editapp-go1.26.5/go/bin/go` |
| Go archive | SHA-256 `5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053` (`/tmp/editapp-go1.26.5/go1.26.5.linux-amd64.tar.gz`) |
| gofmt | `/tmp/editapp-go1.26.5/go/bin/gofmt`; this version has no `-version` flag |
| Node / npm | `v24.14.0` / `11.9.0` |
| FFmpeg / FFprobe | `6.1.1-3ubuntu5` |
| SQLite | `3.50.6` |
| Tailscale | Not installed (`tailscale` was not found) |

The inherited Go build cache is `/home/ar10/.local/share/devboxes/dev-workspace/.cache/go-build` and is read-only to this worktree. The initial required-command pass therefore could not run `go vet` or `go test`. The task-local Go 1.26.5 archive matches the required SHA-256. `web/node_modules` was initially absent, so the checked-in scripts could not find ESLint, Vitest, TypeScript/Vite, or Playwright.

For the reproducible provisioned pass, `npm --prefix web ci` installed the locked dependencies and Go used only `/tmp/editapp-stage0-baseline-gocache` and `/tmp/editapp-stage0-baseline-gomodcache`. The first download attempt was sandbox-blocked while resolving `proxy.golang.org`; the scoped retry succeeded. The Playwright web-server probe was also sandbox-blocked with `connect EPERM 127.0.0.1:5173`; the scoped retry executed the browser tests. No tracked source, test, or configuration files changed.

## Required commands

| Command | Exit | Result |
|---|---:|---|
| `make check GO=/tmp/editapp-go1.26.5/go/bin/go GOFMT=/tmp/editapp-go1.26.5/go/bin/gofmt` | initial 2; provisioned 0 | Initial `go vet` failed on the read-only inherited cache. With `GOCACHE=/tmp/editapp-stage0-baseline-gocache` and `GOMODCACHE=/tmp/editapp-stage0-baseline-gomodcache`, gofmt, vet, ESLint, race tests, and web build passed. |
| `make test GO=/tmp/editapp-go1.26.5/go/bin/go GOFMT=/tmp/editapp-go1.26.5/go/bin/gofmt` | initial 2; provisioned 0 | Initial Go setup failed on the inherited cache. The provisioned pass completed all Go race-test packages and Vitest: 1 file, 4 tests passed. |
| `make smoke GO=/tmp/editapp-go1.26.5/go/bin/go GOFMT=/tmp/editapp-go1.26.5/go/bin/gofmt` | initial 2; provisioned 0 | Initial `go vet` failed on the inherited cache. The provisioned pass completed check, race tests, Go build, and Vite build. |
| `npm --prefix web run test:e2e` | initial 127; first provisioned 1; post-fix 0 | Initial Playwright binary was absent. The first locked-dependency, scoped-loopback observation ran 2 tests: 1 passed and the primary browser flow failed waiting for `Project saved` at `web/playwright/segment-selection.spec.ts:130`. The controller later reproduced the same failure in 1 of 2 full-suite runs at `4310a0a`. The independent verifier subsequently passed 2 of 2 tests twice; the test-only remediation below then passed five consecutive full-suite runs. |

The commands were re-run in a status-reporting shell solely to capture their raw exit values; command behavior and repository files were unchanged.

## Individually identified checks

| Check | Command or path | Result |
|---|---|---|
| Go formatting | `gofmt -l $(git ls-files '*.go')` via `make check` | Passed in the provisioned run; no filenames printed. |
| Go vet | `go vet ./cmd/... ./internal/... ./test/...` via `make check` | Passed in the provisioned run. |
| Go race tests | `go test -race ./cmd/... ./internal/... ./test/...` via `make test` | Passed in the provisioned run. |
| Web lint | `npm --prefix web run lint` | Passed after `npm ci`. |
| Vitest | `npm --prefix web test` | Passed after `npm ci`: 1 file, 4 tests. |
| Web build | `npm --prefix web run build` | Passed after `npm ci`; Vite produced the production bundle. |
| Playwright — initial provisioned observation | `npm --prefix web run test:e2e` | 1 passed, 1 failed waiting for `Project saved`; retained as a non-reproduced/flaky observation. |
| Playwright — independent verifier reruns | `npm --prefix web run test:e2e` | Passed 2 of 2 twice. |
| Playwright — controller reproduction | controller run at `4310a0a` | 1 of 2 full-suite runs failed waiting for `Project saved` at `segment-selection.spec.ts:130`; the other run passed. |
| Playwright — test-only race remediation | `npm --prefix web run test:e2e` | Passed 2 of 2 in five consecutive complete-suite runs on 2026-07-30 with scoped loopback approval. |

## Meaningful command output

```text
pattern ./cmd/...: open /home/ar10/.local/share/devboxes/dev-workspace/.cache/go-build/...: read-only file system
pattern ./internal/...: open /home/ar10/.local/share/devboxes/dev-workspace/.cache/go-build/...: read-only file system
pattern ./test/...: open /home/ar10/.local/share/devboxes/dev-workspace/.cache/go-build/...: read-only file system
make: *** [Makefile:21: lint] Error 1

> playwright test
sh: 1: playwright: not found

go: downloading modernc.org/sqlite v1.55.0
Get "https://proxy.golang.org/...": dial udp 127.0.0.53:53: socket: operation not permitted

1) ... segment-selection.spec.ts:102:1 ...
expect(locator).toBeVisible() failed
Locator: getByText(/Project saved/)
Error: element(s) not found
at web/playwright/segment-selection.spec.ts:130:49
```

## Baseline conclusion

The provisioned baseline passes all Go and non-browser web gates. The first
browser execution had a functional failure. The controller reproduced it in
one of two full-suite runs: the pending preview scheduled by the final marker
change could replace the short-lived save status before its assertion. The
test now waits for that final preview response (`preview-700`) before saving;
five consecutive full-suite runs passed. The initial cache/dependency/loopback
failures are environmental and were resolved only for baseline verification.
Tailscale remains absent, as required for the transport-neutral refactor
verification.
