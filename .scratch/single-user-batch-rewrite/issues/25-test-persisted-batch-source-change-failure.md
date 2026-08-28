# 25: Test persisted batch source-change failure

**What to build:** Add a scheduler-integrated regression test proving a changed or unavailable batch source persists the child failure code `source_changed`.

**Blocked by:** 24

**Category:** bug
**Status:** ready-for-agent

- [ ] A queued batch snapshot with missing or changed source runs through the scheduler.
- [ ] The persisted child job becomes failed with error code `source_changed`.

## Comments

- Opened from post-merge review of ticket 24. Existing tests prove the use case returns the source-change sentinel but do not prove scheduler execution persists its required error code.
