# LosslessCut timeline and player UI

Research target: official `mifi/lossless-cut` source at commit [`5af02818`](https://github.com/mifi/lossless-cut/tree/5af02818fbf0738782e5ac13a4407218b80cc504).

## What LosslessCut does

### Timeline

- `Timeline.tsx` is one horizontally scrollable time coordinate shared by waveform slices, thumbnail tiles, cut segments, keyframes, the actual player position, and the commanded seek position. Zoom is implemented by making each lane `zoom * 100%` wide rather than by changing the time model ([source](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/src/renderer/src/Timeline.tsx)).
- Waveforms are pre-rendered images. At 1× it can use an overview image; at higher zoom it renders time-bounded waveform slices. Thumbnails are separate timed images positioned by percentage ([source](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/src/renderer/src/Timeline.tsx)).
- Seeking and editing share the timeline pointer surface. A primary-button drag seeks. With the configured modifier key held, dragging near the selected segment’s start/end resizes it and dragging inside moves it. The hit threshold is derived from the visible timeline width, so handles remain usable at every zoom ([source](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/src/renderer/src/Timeline.tsx#L280-L359)).
- Playback auto-pans when the relevant cursor exits the visible viewport. Zoom recenters around the commanded time. LosslessCut uses Motion values/springs for that scrolling, but the behavior does not require Motion ([source](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/src/renderer/src/Timeline.tsx#L164-L239)).
- The timeline deliberately distinguishes the player’s observed time from the commanded seek time. This prevents delayed media events from making a just-issued seek look unstable ([source](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/src/renderer/src/Timeline.tsx#L148-L162)).

### Cuts and segments

- Each finite segment is an absolutely positioned percentage-width block. It carries order, label, selected/active state, and a color. A segment without an end is rendered as a marker instead ([source](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/src/renderer/src/TimelineSeg.tsx)).
- Segment mutation is centralized in `useSegments.setCutTime`. Start/end edits enforce ordering, all values are clamped to media duration, and moving preserves segment duration ([source](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/src/renderer/src/hooks/useSegments.tsx#L460-L489)).
- The segment list is a separate detailed management surface. It supports active/selected segments and reorder. LosslessCut uses `@dnd-kit` and TanStack Virtual because its list can be large; those libraries are list concerns, not timeline requirements ([source](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/src/renderer/src/SegmentList.tsx#L1-L14), [rendering](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/src/renderer/src/SegmentList.tsx#L535-L688)).
- The documented core workflow is cursor-first: `I`/`O` set boundaries, Shift-drag moves/resizes, `+` adds, `B` splits, and Backspace removes ([docs](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/docs/index.md#L54-L67), [default key map](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/src/main/configStore.ts#L13-L38)).

### Player controls

- The high-frequency edit controls are arranged symmetrically around a prominent center play/pause button: set/jump start, previous frame/keyframe, play, next frame/keyframe, set/jump end. Timeline start/end and previous/next segment sit farther out ([source](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/src/renderer/src/BottomBar.tsx#L418-L543)).
- Secondary controls form a second, quieter row: waveform/thumbnails/keyframes, zoom, playback rate/FPS, rotation, and related modes ([source](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/src/renderer/src/BottomBar.tsx#L443-L594)).
- Playback, timeline state, and segment state remain separate concerns even though their controls are visually integrated. `App.tsx` wires `Timeline` and `BottomBar` to the same seek and segment actions ([source](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/src/renderer/src/App.tsx#L2690-L2760)).

## Fit with VideoCutlist

Much of the foundation already exists:

- `client/src/features/editor/Timeline.tsx` already shares one percentage-based coordinate across ruler, tiled-thumbnail canvas, waveform canvas, draft in/out markers, saved segments, and playhead.
- `client/src/features/editor/timeline.ts` already keeps playhead, in/out, segments, and zoom in undoable state while playback-only updates avoid history entries.
- `client/src/features/editor/controller.ts` already provides frame stepping, Space, I/O, undo/redo, segment creation, removal, and ordering.
- `client/src/features/preview/PreviewPlayer.tsx` already has play/pause, frame step, time, volume, mute, and fullscreen.
- The backend thumbnail endpoint already returns an FFmpeg `tile=<count>x1` strip, so the current single canvas image is a useful equivalent to LosslessCut’s individually positioned thumbnails (`internal/web/assets/assets.go`).

The main gaps are interaction and composition, not media infrastructure:

1. Controls are split into a player row, a duplicate scrubber, a timeline, and a separate editing toolbar instead of one cursor-centered edit deck.
2. `zoom` affects timeline width but has no visible control or auto-follow behavior.
3. Saved segments have no active selection and cannot be resized/moved on the timeline; only the draft in/out markers can be dragged.
4. There is no hover time readout or visible-window ruler.
5. The visual timeline slider is focusable but has no local keyboard handler; accessibility currently depends on a second range input.

## Recommended implementation

Yes, the useful LosslessCut interaction model fits this app without adopting its React architecture or dependencies.

### Slice 1 — highest value, frontend only

- Put the timeline immediately below the video and place one compact edit deck below it.
- Center play/pause; flank it with frame-step and Set in/Set out. Keep timecode, mute/volume, fullscreen, undo/redo, and Add segment in the same deck but at lower visual emphasis.
- Remove the visible duplicate preview scrubber; keep one keyboard-operable timeline control.
- Add 1×/2×/4×/8×/16× zoom controls using the existing `TimelineSnapshot.zoom` and `viewportScale`.
- Add pointer hover time and update ruler labels for the visible zoom window.

No new dependency or API change is needed.

### Slice 2 — direct segment editing

- Add an ephemeral `activeSegmentIndex` (selection is UI state and should not be persisted unless product requirements say otherwise).
- Add one controller operation that validates/clamps updates to an existing segment.
- Make timeline blocks selectable and expose explicit start/end handles for the active block. On desktop, dragging the body moves it while preserving duration. Explicit handles are more discoverable than copying LosslessCut’s hidden modifier-only behavior.
- Add `B` split and Backspace remove only after active-segment semantics exist.

No drag/drop library is needed; Pointer Events and pointer capture already power the marker drag.

### Slice 3 — only if real usage demands it

- Auto-scroll the zoomed timeline to follow playback.
- Add keyframe ticks only after exposing keyframe data through a safe media-ID API.
- Add drag reorder or list virtualization only if segment counts make the current arrow controls or DOM list measurably inadequate.

## Design and licensing note

LosslessCut is GPL-2.0 ([license](https://github.com/mifi/lossless-cut/blob/5af02818fbf0738782e5ac13a4407218b80cc504/LICENSE)). Reimplement the interaction concepts against this project’s existing SolidJS/state model; do not copy its component source or inline styling unless this project intentionally accepts GPL obligations.
