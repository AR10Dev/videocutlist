# 01: Acquire the verified real-media fixture

**What to build:** An opt-in fixture command downloads, verifies, caches, and atomically publishes the Sintel trailer without committing media.

**Blocked by:** None

**Category:** enhancement
**Status:** complete

- [x] The fixture directory is ignored while attribution remains tracked.
- [x] A valid cached trailer is reused offline.
- [x] Downloads follow redirects, use a bounded timeout, verify SHA-256 and size, and publish by atomic rename.
- [x] Failed or mismatched downloads remove temporary data without replacing a valid cache.
- [x] Missing tools or first-run network failure produce direct, actionable errors.

**Completion evidence:**

- Changed files: `.gitignore`, `test/harness/acquire-real-media.sh`, `test/harness/real-media-attribution.txt`.
- Validation: fixture download and checksum/size verification, cache-hit reuse, mismatch cleanup, and clean diff checks passed; media remains ignored and unstaged.
