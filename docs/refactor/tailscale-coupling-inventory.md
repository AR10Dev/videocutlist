# Tailscale Coupling Inventory

## Method and completeness

Discovery was run against the frozen tracked tree at Stage 0 commit `5f6effa`
with:

```text
git grep -n -i -E 'tailscale|tailnet|tailscaled|ts\\.net|tailscale serve|tailscale funnel|Tailscale-User|Tailscale-App-Capabilities' 5f6effa
```

It returned **132 matching lines in 24 tracked files**. Every matching file is
classified below. There is no Go import of a Tailscale package and no `ts.net`
hostname in the repository. The remaining coupling is string/configuration,
authentication, deployment, test, or source-material coupling.

| Classification | Paths and concrete identifiers | Later treatment |
|---|---|---|
| Production auth boundary | `internal/auth/auth.go`: `loginHeader`, `capsHeader`, `Capabilities`, `mode == "tailscale"`; `internal/config/config.go`: default `EDITAPP_AUTH_MODE=tailscale`, only `tailscale|dev` | Stage 4 replaces provider-shaped identity, header names, and modes with generic principal/authenticator adapters. |
| Runtime contract/public API | `docs/contracts/runtime.md`; `docs/contracts/api.openapi.yaml`: `tailscaleIdentity`, `Tailscale-User-Login`; `docs/adr/0002-identity-boundary.md` | Controller-owned replacements before Stages 1–4; unchanged in Stage 0. |
| Deployment/operations | `deployments/systemd/editapp.env.example`; `scripts/install/install-arch-cachyos.sh`; `scripts/ops/setup-tailscale-serve.sh`; `scripts/ops/verify-deployment.sh`; `scripts/ops/check-deployment-files.sh` | Stage 6 makes the main install provider-neutral and retains Serve only as an optional example. |
| Deployment docs | `docs/runbooks/tailscale-serve.md`; `docs/runbooks/install-arch-cachyos.md`; `docs/runbooks/operations.md`; `docs/release-checklist.md`; `docs/performance-baseline.md`; `docs/implementation-plan.md` | Stage 6 separates optional provider instructions from primary operations. |
| Tests | `test/integration/api/api_test.go`: `TestSpoofedTailscaleHeadersAreRejectedBeforeMedia`, provider mode/header; `internal/config/config_test.go`: default/mode assertions | Stages 3–4 replace with generic proxy-spoofing and auth-mode tests. |
| Test docs | `web/playwright/faults/README.md` | Keep the no-live-provider-path principle; wording may be neutralized in Stage 6. |
| Repository instructions | `AGENTS.md` | Controller-owned; update only after the replacement security posture is frozen. |
| Controller task ledger | `.tasks/integration-risks.md`: clean-host/live-Serve risk; `.tasks/stages/0.md`: Stage 0 required inventory path | Controller coordination records; preserve history and update only through the controller-owned stage process. |
| Prompt/source material | `deep-research-report.md`, `CODEX_MULTI_AGENT_IMPLEMENTATION_PROMPT.md` | Historical source material; do not rewrite during this refactor. |

## Commands, environment, headers, and health assumptions

| Item | Current location | Assumption |
|---|---|---|
| CLI/daemon | setup and verification scripts; installer | `tailscale` executable and `tailscaled` service are required. |
| Provider environment | `EDITAPP_TAILSCALE_APP_CAPS` in setup script/runbooks | A provider capability name is required before Serve configuration. |
| Identity headers | `Tailscale-User-Login`, `Tailscale-App-Capabilities` in `internal/auth/auth.go` | Accepted only from configured trusted CIDRs. |
| Provider command | setup script | `tailscale serve --bg --https=443 --accept-app-caps=… http://127.0.0.1:8787`. |
| Funnel guard | setup/verification scripts and runbook | Funnel is checked/reset/forbidden; the prohibition remains a deployment safety constraint. |
| Health verification | verification script and operations runbook | Health/readiness are loopback `:8787` checks plus a Serve target check. |

## Non-provider network coupling

The companion assumptions document inventories listener, relative API, proxy,
and test occurrences. Key source locations are `internal/config/config.go`,
`cmd/server/main.go`, `web/src/App.tsx`, `web/src/preview.ts`, and
`web/playwright.config.ts`.

## Stage-0 conclusion

No runtime behavior changed. Any provider match found by later controller
searches is a stage failure until classified or removed.
