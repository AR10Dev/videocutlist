# 33: Fix preview global capacity and cancellation publication

**What to build:** Make preview and background FFmpeg work share the configured process budget, and prevent a cancelled preview from publishing a cache artifact.

**Blocked by:** 09

**Category:** bug
**Status:** blocked

- [ ] Preview and background FFmpeg work share one configured process budget.
- [ ] Cancellation before cache publication prevents the artifact from becoming a cache hit and removes its temporary file.
- [ ] Regression tests prove both behaviors.

## Comments

- Opened from review of ticket 09. The preview limiter is independent of background FFmpeg capacity, and cache publication can race request cancellation.
- Merged with ticket 09. Ticket 36 covers the remaining detection-budget and publication-lock cancellation gaps.
