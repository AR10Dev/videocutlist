# 01: Verify export boundary strategies end to end

**What to build:** Executable evidence that stream-copy, precise re-encode, and hybrid smart cut report truthful strategies and boundary warnings for representative keyframe layouts.

**Blocked by:** None (can start immediately)

**Category:** enhancement
**Status:** wontfix

- [x] Keyframe-aligned and sparse-keyframe media exercise all three strategies.
- [x] Results identify the strategy actually used.
- [x] Warning codes and user-visible wording are asserted.
- [x] No result exposes an original-media or internal filesystem path.

## Comments

- Added fixture-backed export coverage and an `appliedStrategy` result field.
- Validation: `make check`, `make test`.
