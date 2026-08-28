# 27: Redact root aliases and test refresh cancellation

**What to build:** Ensure per-root library status cannot expose configured filesystem paths and prove cancelled refreshes preserve prior catalogs.

**Blocked by:** 26

**Category:** bug
**Status:** ready-for-agent

- [ ] Per-root status identifiers reject or redact aliases that could contain filesystem paths.
- [ ] HTTP-visible library status contains no configured root path.
- [ ] A refresh-level cancellation regression proves existing root catalog records remain usable.

## Comments

- Opened from post-merge review of ticket 26. Configured aliases are returned as status-map keys but have no safe-label validation, permitting root-path leakage; cancellation coverage tests scanning, not an existing catalog during `Refresh`.
