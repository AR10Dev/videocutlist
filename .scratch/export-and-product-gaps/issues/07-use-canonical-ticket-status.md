# 07: Use canonical ticket statuses

**What to build:** Keep every local issue status within the documented canonical triage labels so ticket state has one unambiguous meaning.

**Blocked by:** None

**Category:** bug
**Status:** wontfix

- [x] Every ticket status is one of `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, or `wontfix`.
- [x] Deferred work uses its canonical triage status and records the reason in comments.

## Comments

- Replaced obsolete completion and deferred statuses. Completed tickets use `wontfix` because no action remains; ticket 06 uses `needs-triage` pending prioritization.
