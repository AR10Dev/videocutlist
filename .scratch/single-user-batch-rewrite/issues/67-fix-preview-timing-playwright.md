# 67: Fix preview timing Playwright failures

**What to build:** Stabilize the segment-selection preview and watched-marker browser tests against the current Solid Query/reactive preview lifecycle without weakening stale-response assertions.

**Blocked by:** 66

**Category:** bug
**Status:** ready-for-agent

- [ ] MVP preview test observes the current preview status/offset after rapid playhead changes.
- [ ] Watched preview marker test observes current marker mapping after preview readiness.
- [ ] Stale preview responses cannot replace newer preview state.
- [ ] Relevant Playwright tests pass and `make check` passes.

## Comments

Opened from ticket 66: preview offset and watched-marker assertions remain among the 8 failing segment-selection tests.
