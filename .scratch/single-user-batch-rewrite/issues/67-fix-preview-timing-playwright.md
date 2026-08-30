# 67: Fix preview timing Playwright failures

**What to build:** Stabilize the segment-selection preview and watched-marker browser tests against the current Solid Query/reactive preview lifecycle without weakening stale-response assertions.

**Blocked by:** 66

**Category:** bug
**Status:** completed

- [x] MVP preview test observes the current preview status/offset after rapid playhead changes.
- [x] Watched preview marker test observes current marker mapping after preview readiness.
- [x] Stale preview responses cannot replace newer preview state.
- [x] Relevant Playwright tests pass and `make check` passes.

## Comments

Opened from ticket 66: preview offset and watched-marker assertions remain among the 8 failing segment-selection tests.

- Updated preview assertions to wait for the user-visible ready state and returned offset, rather than an unrendered request ID.
- Dispatched `timeupdate` after setting the watched preview position so marker mapping follows the production event path.
- Validation: focused preview Playwright tests pass; `make check` passes.
