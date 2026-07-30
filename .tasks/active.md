# Active

## Core wave ownership

| ID | Owner | Depends on | Allowed paths | Prohibited paths |
|---|---|---|---|---|
| C01 | C | A01,B01,I01 | `internal/media/preview`, `internal/ffmpeg`, `internal/hardware`, `test/integration/preview` | Cache/jobs, API, contracts |
| D01 | D | A01,I01 | `internal/jobs`, `internal/cache`, `internal/limits`, `internal/store/migrations/004_cache.sql`, `test/integration/cache` | Preview runner, API, contracts |
| E01 | E | A01,B01,I01 | `internal/projects`, `internal/export`, project/job store files, migrations 002/003, `test/integration/export` | API, cache, contracts |

All consume `internal/contracts.PreviewRunner` v1 where applicable.
