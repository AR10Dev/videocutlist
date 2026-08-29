# 37: Remove remaining single-user principal contracts

**What to build:** Remove application authorization and ownership contracts that contradict the single-user deployment model.

**Blocked by:** None

**Category:** bug
**Status:** ready-for-agent

- [ ] Application interfaces accept no principal, owner, role, or capability values.
- [ ] Project and job persistence no longer carries ownership fields.
- [ ] Tests cover the single-user API and persistence contract.

## Comments

- Opened from post-merge review of tickets 10 and 34. Remote access and settings paths are now protected, but application and store contracts still carry principal and owner fields.
