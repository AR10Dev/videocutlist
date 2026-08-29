# 39: Fix FFmpeg input and cancellation publication races

**What to build:** Pass detection media descriptors correctly and make cache publication lose to cancellation across preview and assets.

**Blocked by:** None

**Category:** bug
**Status:** completed

- [ ] Detection passes an inherited media descriptor to FFmpeg through `ExtraFiles` and a valid child descriptor path.
- [ ] Cancellation cannot publish a preview or asset cache artifact, including while publication waits for synchronization.
- [ ] Regression tests cover descriptor use and cancellation during publication.

## Comments

- Opened from post-merge review of ticket 36. Detection builds a `/proc/self/fd` path without inheriting the descriptor, and preview/asset publication can win a cancellation race.
- Completed; asset publication follow-up completed by ticket 45.
