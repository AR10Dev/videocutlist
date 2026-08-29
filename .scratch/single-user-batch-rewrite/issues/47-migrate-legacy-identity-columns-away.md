# 47: Migrate legacy identity columns away

**What to build:** Upgrade existing databases to the owner-free schema without dropping preserved project or media records.

**Blocked by:** 43

**Category:** bug
**Status:** completed

- [ ] An upgraded legacy owner-bearing database has no identity columns in production tables.
- [ ] Preserved project and media records survive the migration.

## Comments

- Opened from review of ticket 43: fresh-schema checks do not remove legacy columns from existing databases.
