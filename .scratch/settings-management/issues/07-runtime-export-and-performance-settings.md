# 07: Manage export and performance runtime settings

**What to build:** Move safe operational defaults into the administrator settings screen while retaining deployment-controlled writable base locations and executable paths.

**Blocked by:** 02, 04, 05

**Category:** enhancement
**Status:** wontfix

- [ ] Administrators can configure validated export destination metadata/defaults, preview concurrency/window limits, cache size policy, and media scan limits.
- [ ] Export destinations remain beneath configured deployment export bases, publish complete output atomically, and do not default to overwriting or writing beside a source file.
- [ ] Cache settings affect only disposable generated preview/asset data; cache storage is never treated as source or export storage.
- [ ] Changes that affect active jobs use documented apply-on-next-job behavior; no in-flight FFmpeg process is silently reconfigured.
- [ ] UI labels explain durability: source is read-only, exports are retained according to destination policy, and cache is disposable.
- [ ] Validation tests cover ranges, preview-window consistency, capacity limits, destination containment, and active-job behavior.

## Comments

Superseded by `.scratch/single-user-batch-rewrite/`. Safe limits remain runtime settings; destination paths and executable locations remain deployment-only.

This is intentionally limited to existing operational knobs. Do not introduce encoder configuration, arbitrary executable paths, or source-deletion controls without a separate security/design decision.
