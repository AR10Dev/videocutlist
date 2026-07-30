# Active

| Agent ID | Model | Stage | Role | Branch | Worktree | Allowed paths | Prohibited paths | Dependencies | Acceptance criteria | Required commands | Commit | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `terra-stage-0-impl-1` | `gpt-5.6-terra` | 0 | inventory implementer | `agent/terra-stage-0-inventory` | `.worktrees/terra-stage-0-inventory` | four Stage 0 inventory/plan/ADR outputs | all code, contracts, tests, deployment files, task ledger | frozen Stage 0 contract | inventory completeness; no behavior changes | repository searches | pending | running |
| `terra-stage-0-test-1` | `gpt-5.6-terra` | 0 | baseline test specialist | `agent/terra-stage-0-baseline` | `.worktrees/terra-stage-0-baseline` | `docs/refactor/baseline-test-results.md` | all other paths | frozen Stage 0 contract; Go 1.26.5 | exact reproducible baseline | `make check`; `make test`; `make smoke`; Playwright | pending | running |
