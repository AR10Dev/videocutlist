# 35: Complete detection and scan unified-job contract

**What to build:** Persist and validate immutable detection inputs, retain per-root scan results, and remove obsolete production job paths.

**Blocked by:** 32

**Category:** bug
**Status:** completed

- [ ] Detection jobs persist a source fingerprint and bounded detector parameters, then reject a changed source at execution.
- [ ] Scan jobs persist safe results for every scanned root and expose them through unified job retrieval.
- [ ] Production no longer uses in-memory import maps or separate detection compatibility job paths.
- [ ] Regression tests cover all behaviors.

## Comments

- Opened from review of ticket 32. Detection requests omit immutable fingerprint and bounded parameters, scan jobs persist `{}`, and legacy production paths remain.
- Merged with ticket 32. Ticket 38 covers unified scan result retrieval and the remaining in-memory import fallback.
