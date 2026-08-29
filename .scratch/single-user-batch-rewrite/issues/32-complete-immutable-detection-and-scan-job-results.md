# 32: Complete immutable detection and scan job results

**What to build:** Persist immutable bounded detection requests and per-root durable scan results, then remove obsolete compatibility job paths.

**Blocked by:** 08

**Category:** bug
**Status:** completed

- [ ] Detection job requests include a media source fingerprint and bounded detector parameters; execution rejects changed sources.
- [ ] Scan jobs retain safe per-root scan results for unified job retrieval.
- [ ] The in-memory import job map and separate detection-store compatibility paths are removed from production packages.
- [ ] Regression tests cover changed detection source, bounded parameters, per-root scan result persistence, and removed legacy paths.

## Comments

- Opened from post-merge review of ticket 08. Detection requests retain only media ID/revision/kind; scans submit/store `{}` without root results; obsolete in-memory import and detection compatibility implementations remain.
- Implemented and merged with ticket 35. Post-merge review found unified job retrieval omits persisted root results and the in-memory import fallback remains. Follow-up: ticket 38.
