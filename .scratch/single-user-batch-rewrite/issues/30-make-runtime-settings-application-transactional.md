# 30: Make runtime settings application transactional

**What to build:** Apply all runtime settings as one reversible operation so any runtime failure restores configuration, scanner, and service limits before HTTP settings persistence proceeds.

**Blocked by:** 29

**Category:** bug
**Status:** ready-for-agent

- [ ] Failed scanner reconfiguration leaves runtime config unchanged.
- [ ] Failure in any later runtime-setting application restores prior scanner and all previously changed runtime limits/configuration.
- [ ] Persisted settings change only after all runtime application succeeds.
- [ ] Regression tests inject failures at scanner and later application steps and assert full rollback.

## Comments

- Opened from post-merge review of ticket 29. Runtime application mutates config before scanner reconfiguration and does not roll back earlier changes when later limit/cache application fails, leaving runtime inconsistent despite HTTP persistence rollback.
