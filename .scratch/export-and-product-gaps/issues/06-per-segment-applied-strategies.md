# 06: Report per-segment applied export strategies

**What to build:** For multi-segment hybrid exports, report the strategy actually used for each published segment so clients do not infer that one job-level strategy applied to every segment.

**Blocked by:** None (ticket 01 is complete)

**Category:** bug
**Status:** complete

- [x] Mixed hybrid and stream-copy fallback exports identify each segment's applied strategy.
- [x] Job-level strategy remains clearly defined or is replaced without misleading clients.
- [x] Warning details and applied-strategy data agree for every segment.
- [x] Public results continue to exclude original-media and internal filesystem paths.

## Comments

- Triage: ready for an agent. This is a public-result truthfulness bug: the current job-level `appliedStrategy` derives from whether any segment has a hybrid interior keyframe, so it can misdescribe other segments.
- Added `result.appliedStrategies` with per-segment strategies and published filenames. Mixed jobs omit the job-level `appliedStrategy`.
- Validation: `make test`, `make check`, `make smoke`.
