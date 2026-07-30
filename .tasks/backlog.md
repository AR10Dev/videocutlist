# Backlog

| ID | Owner | Depends on | Allowed paths | Acceptance |
|---|---|---|---|---|
| C01 | C | A,B,I | `internal/media/preview`, `internal/ffmpeg`, `internal/hardware`, `test/integration/preview` | Valid incremental fMP4 and cancellation |
| D01 | D | A,I | `internal/jobs`, `internal/cache`, `internal/limits`, `test/integration/cache` | Limits, single-flight, atomic cache |
| E01 | E | A,B,I | `internal/projects`, `internal/export`, assigned project/job migrations, `test/integration/export` | Revisions and stream-copy export |
| F01 | F | B,C,D,E | `internal/api`, `internal/auth`, `internal/httpx`, `test/integration/api` | Frozen API and auth |
| G01 | G | A,F contract | `web/src`, `web/tests`, `web/playwright` | MSE segment UI and E2E |
| H01 | H | F,G | `deployments`, `scripts/install`, `scripts/ops`, `docs/runbooks` | Hardened install and operations |
| J01 | J | F,G,H | Read-only | Severity-ranked security review |

All tasks prohibit controller contracts and unrelated modules. Required tests
are the owning package tests plus the applicable phase gate. Each task produces
a commit and the standard handoff from the implementation prompt.

