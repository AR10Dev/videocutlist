# 48: Remove forwarded-user deployment guidance

**What to build:** Align deployment documentation with the identity-free proxy access gate.

**Blocked by:** 43

**Category:** bug
**Status:** completed

- [ ] Deployment guides do not instruct proxies to set `X-Forwarded-User`.
- [ ] Guides describe access gating without application identities.

## Comments

- Opened from review of ticket 43: proxy documentation still recommends the removed identity header.
