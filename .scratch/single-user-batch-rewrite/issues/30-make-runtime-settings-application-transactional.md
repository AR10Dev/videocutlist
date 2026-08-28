# 30: Make runtime settings application transactional

**What to build:** Apply all runtime settings as one reversible operation so any runtime failure restores configuration, scanner, and service limits before HTTP settings persistence proceeds.

**Blocked by:** 29

**Category:** bug
**Status:** completed

- [x] Failed scanner reconfiguration leaves runtime config unchanged.
- [x] Failure in any later runtime-setting application restores prior scanner and all previously changed runtime limits/configuration.
- [x] Persisted settings change only after all runtime application succeeds.
- [x] Regression tests inject failures at scanner and later application steps and assert full rollback.

## Comments

- Opened from post-merge review of ticket 29. Runtime application mutates config before scanner reconfiguration and does not roll back earlier changes when later limit/cache application fails, leaving runtime inconsistent despite HTTP persistence rollback.
- Added a transactional runtime-settings helper that restores cache, preview limits, scan limits, scanner roots, and config in reverse order on any failure. Added injected scanner and later-step failure tests; `make check` passed.
