# 03: Verify media and derived assets through HTTP

**What to build:** Real-process tests cover health, readiness, static delivery, media scan/browse/import, preview, thumbnails, and waveform using the verified trailer.

**Blocked by:** 02

**Category:** enhancement
**Status:** ready

- [ ] Health, readiness, static app, media status/list/tree/detail, refresh aliases, and import lifecycle routes are exercised.
- [ ] Metadata matches FFprobe within documented rounding and responses contain no filesystem paths.
- [ ] Preview boundary clamping, HEAD miss/hit, playable bytes, cache miss-to-hit, conditional requests, cancellation, and partial-file cleanup are proved.
- [ ] Thumbnail and waveform payloads validate and cache hits are proved.
- [ ] Scan and import cancellation or documented terminal behavior is exercised with deadlines.
