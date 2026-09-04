# 03: Focus the editor on the timeline workflow

**What to build:** Make the full-video timeline the central seek control, identify the preview as an absolute source window, order marker actions as Set start, Set end, Add segment, and keep the selectable/removable segment list visible.

**Blocked by:** 01

**Category:** enhancement
**Status:** complete

- [x] Preview range, absolute playhead, and full duration use one consistent time format.
- [x] The preview does not expose a second prominent seek bar.
- [x] Filmstrip thumbnails are readable and include visible time references.
- [x] Add segment is disabled for invalid or empty markers and visibly explains why.
- [x] Segment rows expose label, duration, selection state, and remove action; selection highlights the timeline range.
- [x] Frame stepping, playback, markers, undo, and redo retain documented keyboard access.

## Comments

- 2026-09-03: Integrated timeline workflow commit 22aa6ac (handoff 389c837); focused diff check passed. Preview range labels, timeline scale labels, marker ordering, invalid-range guidance, segment selection highlighting, and custom playback control are implemented. Automated client checks were unavailable because dependencies are not installed.
