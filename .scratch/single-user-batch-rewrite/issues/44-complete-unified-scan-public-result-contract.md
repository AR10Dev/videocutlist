# 44: Complete unified scan public result contract

**What to build:** Expose validated persisted per-root scan results through unified job responses, including failed scans.

**Blocked by:** 41

**Category:** bug
**Status:** completed

- [ ] Unified job lookup and `/api/v1/jobs/{jobId}` return validated safe root scan results.
- [ ] Failed or partial scans persist their safe root results before returning failure.
- [ ] Regression coverage rejects unsafe persisted values and covers failed scan results.

## Comments

- Opened from review of ticket 41: public unified jobs omit scan results, failure paths do not persist them, and result decoding is not validated.
- Completed; ticket 46 updated the obsolete refresh regression.
