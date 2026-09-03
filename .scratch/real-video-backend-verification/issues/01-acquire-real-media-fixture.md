# 01: Acquire the verified real-media fixture

**What to build:** An opt-in fixture command downloads, verifies, caches, and atomically publishes the Sintel trailer without committing media.

**Blocked by:** None

**Category:** enhancement
**Status:** ready

- [ ] The fixture directory is ignored while attribution remains tracked.
- [ ] A valid cached trailer is reused offline.
- [ ] Downloads follow redirects, use a bounded timeout, verify SHA-256 and size, and publish by atomic rename.
- [ ] Failed or mismatched downloads remove temporary data without replacing a valid cache.
- [ ] Missing tools or first-run network failure produce direct, actionable errors.
