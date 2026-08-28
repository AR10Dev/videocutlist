# 28: Make root-removal reconfiguration atomic

**What to build:** Prevent failed root removal from leaving configured roots and available catalog records inconsistent, and complete media-indexing regression coverage.

**Blocked by:** 27

**Category:** bug
**Status:** completed

- [x] A failed root-record removal leaves the previous scanner configuration and catalog availability intact.
- [x] A successful root removal hides that root’s media only after configuration succeeds.
- [x] Refresh cancellation proves the original media record remains retrievable.
- [x] Reconfiguration rejects path-like aliases as well as duplicate and relative roots.

## Comments

- Opened from post-merge review of ticket 27. `Scanner.Reconfigure` publishes new root configuration before `RemoveRoot`; a removal failure leaves old-root records available despite no configured root. Regression tests also need identity-level cancellation and reconfiguration alias coverage.
- Added an atomic `RemoveRoots` catalog boundary, invoking it before publishing scanner configuration; SQLite updates all removed aliases in one transaction. Added failed-removal preservation, cancellation retrieval, and safe-alias regression coverage. `make check` passed.
