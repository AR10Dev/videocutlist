# 04: Verify projects, interchange, and detection

**What to build:** Real-process tests cover project persistence and revision control, interchange, and all detection kinds against the trailer.

**Blocked by:** 02

**Category:** enhancement
**Status:** ready

- [ ] Project create, read, list pagination, update, and stale-revision rejection preserve the expected state.
- [ ] CSV and chapter export/import increment revisions; invalid or out-of-bounds input returns safe 422 without mutation.
- [ ] Silence, black, and scene detection jobs reach terminal success through real FFmpeg.
- [ ] Returned candidates have correct opaque IDs, source kind, bounded times, and confidence.
- [ ] Stale source fingerprint or revision fails safely and does not mutate the project.
