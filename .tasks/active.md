# Active

No implementation task is active until the contract commit passes review.

## Initial wave ownership

| ID | Owner | Depends on | Allowed paths | Prohibited paths |
|---|---|---|---|---|
| A01 | A | contracts | `go.mod`, `go.sum`, `Makefile`, `.editorconfig`, `.golangci.yml`, `web/package.json`, `web/tsconfig.json`, `web/vite.config.*`, `.github/workflows`, `scripts/dev`, configuration skeleton | Domain services and contracts |
| B01 | B | contracts; A for final tests | `internal/media/index`, `internal/media/probe`, assigned media store/migration, `test/fixtures/media` | HTTP, preview, cache, contracts |
| I01 | I | contracts; A for final tests | `test/harness`, `test/performance`, `test/faults`, `web/playwright/faults`, `docs/test-plan.md` | Product implementation and contracts |

