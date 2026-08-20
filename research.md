# Research: LosslessCut for a local video-cut-list app

## Summary

LosslessCut’s mature product model is a segment-first, local FFmpeg workflow: users mark time ranges (or markers), reorder/invert them, then export separate files or a merged file while copying streams whenever possible. The strongest patterns to borrow are explicit keyframe-vs-precision tradeoffs, visible timeline evidence (thumbnails/waveform/keyframes), durable project files, and track-aware export. Smart cut, HTTP automation, and advanced expressions are useful but should remain clearly experimental/advanced.

## Findings

1. **P0 — Make segments the primary data model and support non-destructive projects.** A segment has start/end, export order, optional label/tags; a marker has no end and is excluded from export. Projects use a native JSON5 `.llc` file containing timeline segment information, with CSV/TSV and other import/export formats. This maps directly to a cut-list app and makes edits repeatable without touching originals. [Docs: segments, markers, projects](https://github.com/mifi/lossless-cut/blob/master/docs/index.md#segments) · [Source: `docs/index.md`](https://github.com/mifi/lossless-cut/blob/master/docs/index.md)

2. **P0 — Offer separate-file and merge-cuts export modes, with explicit ordering.** LosslessCut exports every selected segment as a new file by default, can invert selection to export the gaps, and can merge selected segments in panel order. Drag/drop reordering is user-visible and affects merged output order. [Docs: cutting workflow](https://github.com/mifi/lossless-cut/blob/master/docs/index.md#cutting) · [Source: `docs/index.md`](https://github.com/mifi/lossless-cut/blob/master/docs/index.md)

3. **P0 — Surface keyframe limitations instead of promising frame-exact lossless cuts.** Default keyframe mode cuts at the nearest preceding keyframe (reliable playback, but start may be early); normal cut improves timestamp semantics but can create decoding artifacts. The timeline displays keyframes, and the docs say a precise lossless cut is generally impossible without a usable nearby keyframe. This is a **high-severity correctness/UX caveat** for any cut-list app: label actual output boundaries and avoid claiming frame exactness. [Source: `ExportConfirm.tsx` (`onKeyframeCutHelpPress`)](https://github.com/mifi/lossless-cut/blob/master/src/renderer/src/components/ExportConfirm.tsx) · [Troubleshooting: inaccurate times](https://github.com/mifi/lossless-cut/blob/master/docs/troubleshooting.md#cutting-times-are-not-accurate)

4. **P1 — Keep precision re-encoding opt-in and warn clearly.** Smart cut re-encodes from the requested cut point to the next keyframe and copies the remainder, attempting an accurate boundary. The UI calls it experimental, warns it will not work on all files, and source help notes stronger results on some H.264 than H.265. Troubleshooting reports failures and duplicated segments. **High severity:** never silently switch a “lossless” export into this mode. [Source: `ExportConfirm.tsx` (`onSmartCutHelpPress`, notices)](https://github.com/mifi/lossless-cut/blob/master/src/renderer/src/components/ExportConfirm.tsx) · [Troubleshooting: Smart cut](https://github.com/mifi/lossless-cut/blob/master/docs/troubleshooting.md#smart-cut-not-working)

5. **P1 — Treat tracks/streams as first-class export choices.** LosslessCut can selectively enable/disable and add tracks, including video, audio, subtitles, attachments and metadata/disposition handling; all tracks are cut equally where supported. This is valuable for local workflows (remove unwanted audio, add external subtitles, preserve selected streams), but the UI/docs warn that some track types cannot be cut and incompatible containers/codecs can fail. **Medium severity:** export validation should identify problematic streams and let users disable them. [Docs: tracks and remuxing](https://github.com/mifi/lossless-cut/blob/master/docs/index.md#tracks) · [Source: `ExportConfirm.tsx`](https://github.com/mifi/lossless-cut/blob/master/src/renderer/src/components/ExportConfirm.tsx)

6. **P1 — Build navigation around timeline evidence and reversible operations.** Mature UX includes video thumbnails, audio waveform, timeline zoom, frame/keyframe jumping, manual timecode entry, keyboard shortcuts, undo/redo, labels/tags, and black/silence/scene-change detection. Prioritize thumbnails/waveform/zoom, frame/keyframe stepping, keyboard actions, and undo/redo; detections are useful accelerators but should not replace user confirmation. [README feature list](https://github.com/mifi/lossless-cut/blob/master/README.md#features) · [Docs: cutting workflow](https://github.com/mifi/lossless-cut/blob/master/docs/index.md#cutting)

7. **P1 — Preserve media quality through stream copy/remux, with explicit container caveats.** The app’s core value is near-direct FFmpeg data copy; remuxing can change containers without changing codec data, but metadata may be lost and not every container supports every codec (e.g. common players may not support Matroska). A local app should expose output-container choice and explain compatibility rather than imply universal losslessness. [README](https://github.com/mifi/lossless-cut/blob/master/README.md#features) · [Docs: codecs vs formats/remuxing](https://github.com/mifi/lossless-cut/blob/master/docs/index.md#primer-videoaudio-codecs-vs-formats)

8. **P2 — Add project interchange and automation only after the core cut list is solid.** LosslessCut supports chapter marks, text/YouTube/CSV/CUE/XML interchange, a basic CLI, and an HTTP API. The API is explicitly experimental, localhost-only, unauthenticated, and rejects browser-origin requests; its documented endpoints include action execution and export-complete events. **Medium security severity:** if implemented, bind localhost, validate requests, and never expose it remotely by default. [Docs: HTTP API](https://github.com/mifi/lossless-cut/blob/master/docs/api.md) · [Docs: project import/export](https://github.com/mifi/lossless-cut/blob/master/docs/index.md#importexport-projects)

9. **P2 — Advanced expression tooling is optional power-user functionality.** JavaScript expressions can select/edit segments, filter tracks, and generate output filename values. It is useful for batch cut-list operations but is not necessary for the first user-visible release and increases safety/testing scope. [Docs: JavaScript expressions](https://github.com/mifi/lossless-cut/blob/master/docs/expressions.md)

## Priority recommendations

- **Implement first (P0):** segment/marker model; project autosave/load; separate vs merged export; visible order; keyframe visualization; truthful boundary/status reporting.
- **Next (P1):** track selector with stream validation; thumbnails/waveform/zoom/frame stepping; undo/redo and shortcuts; explicit remux/container warnings; opt-in smart cut with prominent experimental warning.
- **Later (P2):** chapter/CSV interchange, CLI/API, expression-based batch operations, scene/silence detection and other automation.
- **Explicitly out of scope for a lossless-first app:** transitions, overlays, resize/crop effects, color grading, audio mixing, and burned subtitles; LosslessCut’s docs position these as re-encoding/editor territory. [Docs](https://github.com/mifi/lossless-cut/blob/master/docs/index.md#primer-videoaudio-codecs-vs-formats)

## Sources

- Kept: [LosslessCut README](https://github.com/mifi/lossless-cut/blob/master/README.md) — official feature inventory and product scope.
- Kept: [`docs/index.md`](https://github.com/mifi/lossless-cut/blob/master/docs/index.md) — first-party workflow, segment, track, project, and remux behavior.
- Kept: [`docs/troubleshooting.md`](https://github.com/mifi/lossless-cut/blob/master/docs/troubleshooting.md) — keyframe, track, merge, and Smart Cut limitations.
- Kept: [`src/renderer/src/components/ExportConfirm.tsx`](https://github.com/mifi/lossless-cut/blob/master/src/renderer/src/components/ExportConfirm.tsx) — implemented export warnings/help and cut-mode semantics.
- Kept: [`docs/api.md`](https://github.com/mifi/lossless-cut/blob/master/docs/api.md) and [`docs/expressions.md`](https://github.com/mifi/lossless-cut/blob/master/docs/expressions.md) — official automation and advanced workflows.
- Dropped: third-party reviews, videos, discussions, and issue commentary — not first-party docs/source evidence required by the task.

## Gaps

The repository docs do not provide a controlled benchmark of export speed, exact codec/container compatibility coverage, or a complete guarantee for every stream type. Validate the target app with representative H.264/H.265, variable-frame-rate, subtitle, multi-audio, and low-keyframe fixtures; inspect outputs rather than relying only on FFmpeg exit success.

## Acceptance report

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete, prioritized LosslessCut findings include repository file paths, official URLs, and severity labels for keyframe, Smart Cut, stream, remux, and API risks."
    }
  ],
  "changedFiles": [
    "/workspace/Documents/videocutlist/research.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Research was restricted to official mifi/lossless-cut GitHub README, docs, and source URLs."
  ],
  "residualRisks": [
    "No controlled performance or exhaustive codec/stream compatibility benchmark was found in first-party material.",
    "Smart Cut remains experimental and keyframe-based lossless cuts may not be frame-exact."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added the requested official-source research brief; no application files changed.",
  "reviewFindings": [
    "no blockers: research.md contains cited findings, implementation paths, severity caveats, and priority recommendations"
  ],
  "manualNotes": "Only official repository README, docs, and source were retained as evidence."
}
```
