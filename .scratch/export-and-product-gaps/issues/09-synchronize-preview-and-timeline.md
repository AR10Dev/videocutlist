# 09: Synchronize preview and timeline position

**What to build:** Video playback, the timeline playhead, timecode seeking, frame stepping, and In/Out markers use one authoritative media position.

**Blocked by:** None

**Category:** bug
**Status:** ready-for-agent

- [ ] Playing or scrubbing the preview updates the visible timeline playhead and current time without adding an undo entry for every playback event.
- [ ] Dragging the timeline, entering a timecode, or stepping a frame seeks the preview to the same media position.
- [ ] Setting In or Out immediately after any seek uses the displayed position, including when the preview is a bounded window with a non-zero offset.
- [ ] Preview-window reloads preserve the requested media position and do not move both markers to the end of the loaded window.
- [ ] Undo and redo restore deliberate edit positions without recording passive playback updates.
- [ ] Unit and Playwright tests reproduce the timecode-to-marker mismatch and cover playback, timeline, frame-step, and non-zero preview-offset synchronization.

## Comments

The review at `c2dcedf` reproduced two independent clocks: timeline and timecode controls update `playheadMs`, while marker controls read `video.currentTime`, and playback does not update the timeline. Seeking to 3 seconds and then 8 seconds through the timecode control produced both markers near 8.021 seconds while the displayed playhead remained at zero.
