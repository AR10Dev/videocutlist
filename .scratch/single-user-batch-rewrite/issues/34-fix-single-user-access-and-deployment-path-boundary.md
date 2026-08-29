# 34: Fix single-user access and deployment-path boundary

**What to build:** Reject unauthenticated non-loopback application access and keep deployment filesystem paths out of browser-controlled settings APIs.

**Blocked by:** 10

**Category:** bug
**Status:** completed

- [ ] A non-loopback listener cannot use unauthenticated application access.
- [ ] Browser settings responses redact all deployment filesystem paths.
- [ ] Browser settings mutations cannot set media-root or export-destination filesystem paths.
- [ ] Regression tests cover all three behaviors.

## Comments

- Opened from review of ticket 10. `AUTH_MODE=none` remains valid on non-loopback listeners, and settings GET/PUT still expose and mutate deployment paths.
- Merged. Non-loopback unauthenticated access is rejected, settings responses redact deployment paths, and browser mutations cannot change deployment paths.
