# Active

## API and browser wave ownership

| ID | Owner | Depends on | Allowed paths | Prohibited paths |
|---|---|---|---|---|
| F01 | F | B01,C01,D01,E01 | `internal/api`, `internal/auth`, `internal/httpx`, `internal/metrics`, `test/integration/api` | Contracts and domain implementations |
| G01 | G | A01,Frozen OpenAPI | `web/src`, `web/tests`, `web/playwright`, web test config | Backend and contracts |

Both consume `docs/contracts/api.openapi.yaml` v1 without modifying it.
