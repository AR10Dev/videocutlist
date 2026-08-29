# 43: Remove remaining identity compatibility plumbing

**What to build:** Remove the remaining per-user preview, ownership-migration, and forwarded-user compatibility contracts.

**Blocked by:** 40

**Category:** bug
**Status:** completed

- [ ] Preview admission and settings are global only.
- [ ] Production migration and proxy contracts carry no owner or user identity fields.
- [ ] Regression coverage verifies the owner-free, global-only behavior.

## Comments

- Opened from review of ticket 40: per-user preview limits, owner migration, and `X-Forwarded-User` compatibility plumbing remain.
- Completed with migration and documentation follow-ups in tickets 47 and 48.
