# 08: Make the editing workspace focused and contextual

**What to build:** A user editing one video sees the preview, timeline, cut list, and next export action first; project administration, detection, diagnostics, and uncommon export controls appear only when requested.

**Blocked by:** 06

**Category:** enhancement
**Status:** complete

- [x] The primary workspace shows source name and duration, synchronized current/In/Out times, preview, timeline, segment rows, and one `Export N segments` action.
- [x] Every segment row shows its order, label, start, end, and duration with remove and descriptively labelled reorder controls.
- [x] Project ID and interchange actions move behind a Project disclosure or menu.
- [x] Detection moves behind a separate tool or disclosure and does not compete with manual clipping.
- [x] Preview request IDs, cache timings, and similar diagnostics move out of the editor into About/Diagnostics under Settings.
- [x] Export review shows scope, destination, filename, duration/count, and the stream-copy keyframe warning; stream selection, templates, and uncommon strategy controls are under Advanced.
- [x] Before media selection, mobile layout presents the media library before the editor; after selection, the clipping task remains usable at 320 px without horizontal overflow.
- [ ] Playwright coverage exercises first run, media selection, one-segment editing, export review, mobile order, and accessible reorder names.

## Comments

The first contextual-inspector pass was previously completed. Reopened after the review at `c2dcedf` found that the selected-media workspace still presents project UUID, interchange, preview diagnostics, export internals, and three detection actions at once.

Use LosslessCut's segment-first layout as the reference boundary. Do not add multi-track editing controls or expose codec settings that this product does not support.
