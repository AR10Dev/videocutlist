# Implementation Plan

## Objective

Deliver the MVP specified by `deep-research-report.md` using the staged
multi-agent program in `CODEX_MULTI_AGENT_IMPLEMENTATION_PROMPT.md`.

## Current state and constraints

- The repository began with specifications only.
- Available: Node 26.5, npm 11.17, FFmpeg/FFprobe 6.1.1, SQLite 3.50.6,
  Git, Make, curl, and jq.
- Missing at inspection: Go and Tailscale.
- FFmpeg contains libx264, NVENC, QSV, and VAAPI encoders, but no GPU device is
  visible. Only libx264 may be accepted in this environment.
- The production installation target is Arch/CachyOS; the controller workspace
  is Ubuntu.

## Dependency graph

```text
contracts
  -> A foundation ----\
  -> B media/index ----> foundation gate
  -> I test harness ---/
       -> C preview ---\
       -> D jobs/cache --> core gate
       -> E export ----/
            -> F API ---\
            -> G web ----> API/browser gate
                 -> H operations
                 -> J security review
                      -> remediation -> release gate
```

Agents A, B, and I start together. B and I rebase onto A before final testing.
The controller owns the adapter between C and D.

## Integration gates

1. Contracts: OpenAPI and JSON Schema validate; ledgers and ADRs are committed.
2. Foundation: `go test ./...`, `npm --prefix web test`, and
   `npm --prefix web run build`.
3. Core: preview streams before completion, validates, caches, deduplicates,
   cancels, and a compatible stream-copy export succeeds.
4. Browser/API: Playwright proves metadata, preview offset, stale cancellation,
   project save/reload, and marker behavior.
5. Deployment/security: loopback binding, no Funnel, path containment,
   authorization-before-spawn, and systemd least privilege.
6. Release: formatting, vet, race tests, unit/integration/E2E/security/smoke
   suites, runbooks, baseline measurements, and no high findings.

## MVP acceptance

The definition of done is the 17-point MVP list in the multi-agent prompt.
No phase is complete until its gate passes on the integration branch.

## Initial risks

- Go and Tailscale installation may require host access.
- MSE streaming correctness depends on FFmpeg fragment boundaries and browser
  behavior; fixture-backed Playwright coverage is mandatory.
- A localhost proxy cannot distinguish Tailscale Serve from another trusted
  local process; the OS account boundary is part of the trust model.
- Stream copy is keyframe/container constrained and must return warnings.
- Full-disk and cancellation paths can corrupt outputs unless temp/rename
  invariants are applied universally.

