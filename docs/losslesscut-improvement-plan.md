# LosslessCut-inspired improvement plan

## 1. Export choices and ordered cut lists

Add `merge` and `separate` output modes, preserve the segment list's order, and allow exporting the unselected gaps. Validate overlaps by timeline position rather than list order. Return every published filename for separate exports.

## 2. Truthful cut accuracy

Keep stream copy as the default and label it as keyframe-dependent. Show that requested boundaries may start at an earlier keyframe. Add an explicit, opt-in precision re-encode mode. Do not claim that either mode is frame exact without inspecting output.

## 3. Faster review

Add manual timecode entry and frame-sized stepping when the probe supplies a frame rate. Timeline thumbnails, waveform rendering, automatic detection, and undo/redo remain later work because they need a dedicated timeline/editor state model and media fixtures.

## 4. Track-aware export

Expose indexed stream metadata from FFprobe. Let an export choose stream indexes, defaulting to all streams, and reject unknown or duplicate indexes before FFmpeg runs. MKV remains the only output container, so a container matrix is not needed yet.

## 5. Opt-in precision cuts

Implement the safe baseline: re-encode selected clips only when the user explicitly chooses `precise_reencode`. It is not LosslessCut's hybrid Smart Cut and must be marked experimental. A codec-specific hybrid path waits for representative H.264/H.265/VFR output tests.

## 6. Project interchange

Add a versioned JSON cut-list export/import in the browser. Import validates its shape locally, then the existing server-side project validation remains authoritative. CSV, chapter formats, automation APIs, and path-bearing project files are later work.

## Delivery order

1. Export request/result and domain validation.
2. FFprobe tracks and FFmpeg mapping.
3. Editor controls and project JSON interchange.
4. Targeted Go and Vitest coverage, then `make check`.
