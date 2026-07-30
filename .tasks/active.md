# Active

## Deployment and security wave ownership

| ID | Owner | Depends on | Allowed paths | Prohibited paths |
|---|---|---|---|---|
| H01 | H | F01,G01 | `deployments/systemd`, `deployments/docker`, `scripts/install`, `scripts/ops`, `docs/runbooks` | Product code and contracts |
| J01 | J | F01,G01,H01 | Read-only | All writes until controller assigns remediation |

J begins after H commits so its review covers the production deployment.
