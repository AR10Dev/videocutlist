# 36: Complete global FFmpeg capacity and cache cancellation

**What to build:** Include every FFmpeg caller in one global process budget and make cancellation atomic with cache publication.

**Blocked by:** None

**Category:** bug
**Status:** ready-for-agent

- [ ] Detection, preview, export, and asset FFmpeg execution acquire the same configured global capacity.
- [ ] Cancellation at any point before publication prevents a cache hit.
- [ ] Regression tests cover detection saturation and cancellation while publication waits.

## Comments

- Opened from post-merge review of tickets 09 and 33. Detection bypasses the shared limiter, and cancellation can occur after the final context check but before cache publication.
