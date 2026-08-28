# 27: Redact root aliases and test refresh cancellation

**What to build:** Ensure per-root library status cannot expose configured filesystem paths and prove cancelled refreshes preserve prior catalogs.

**Blocked by:** 26

**Category:** bug
**Status:** completed

- [x] Per-root status identifiers reject or redact aliases that could contain filesystem paths.
- [x] HTTP-visible library status contains no configured root path.
- [x] A refresh-level cancellation regression proves existing root catalog records remain usable.

## Comments

- Opened from post-merge review of ticket 26. Configured aliases are returned as status-map keys but have no safe-label validation, permitting root-path leakage; cancellation coverage tests scanning, not an existing catalog during `Refresh`.
- Added a bounded safe alias contract (`[A-Za-z0-9][A-Za-z0-9_-]{0,63}`) at scanner construction and reconfiguration, plus a refresh cancellation regression that seeds a catalog and verifies it remains unchanged.
