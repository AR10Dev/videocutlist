# 09: Isolate preview capacity and cache publication

**What to build:** Interactive preview execution that remains responsive beside background jobs and safely handles concurrent misses for one cache key.

**Blocked by:** 04

**Category:** bug
**Status:** ready-for-agent

- [ ] Preview requests use a separate interactive limit and never become durable background jobs.
- [ ] A global process budget prevents previews and background FFmpeg work from exceeding configured machine capacity.
- [ ] Cached previews do not consume an FFmpeg slot.
- [ ] Concurrent misses for one key use unique temporary files.
- [ ] Only a complete FFprobe-validated file may win atomic cache publication; losing writers remove their temporary files.
- [ ] Request cancellation terminates FFmpeg with bounded cleanup and leaves no cache hit or partial artifact.
- [ ] Preview headers map the requested timestamp into the preview window without claiming frame exactness.
- [ ] Tests cover cache races, cancellation, background saturation, cache hits, and validation failure.

## Comments
