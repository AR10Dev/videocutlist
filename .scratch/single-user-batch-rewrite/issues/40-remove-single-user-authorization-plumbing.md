# 40: Remove single-user authorization plumbing

**What to build:** Remove remaining principal, role, capability, and owner migration plumbing from the application and HTTP API.

**Blocked by:** None

**Category:** bug
**Status:** completed

- [ ] Production application and HTTP interfaces carry no principal, role, capability, or authorizer values.
- [ ] The deployment access gate authenticates requests without exposing application identities.
- [ ] Legacy ownership migration code and multi-principal tests are removed or replaced with single-user coverage.

## Comments

- Opened from post-merge review of ticket 37. Persistence fields were removed, but principal authorization types and HTTP authorization plumbing remain in production.
- Completed with follow-up tickets 43, 47, and 48.
