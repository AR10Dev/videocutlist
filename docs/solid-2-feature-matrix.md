# Solid 2 feature matrix

Reference: `client/` React frontend. Port: `client-solid/` Solid 2.

| Feature | Status | Evidence | Remaining risk |
| --- | --- | --- | --- |
| API configuration/auth/opaque IDs | Ported | `client-solid/src/api.ts`; API tests pass | None known |
| Media list/pagination/refresh/selection | Ported | `App.tsx`; refresh has 403/429 messages and reconciles selected metadata with guarded requests | Browser-only prompt flow not automated |
| Timeline markers/segments/history/zoom | Ported | `App.tsx`, `timeline.ts`, `TimelineCanvas.tsx`; labelled segment list supports reorder/remove | Browser-only interaction evidence limited |
| Timecode and keyboard controls | Ported | Solid App validates `m:ss.mmm`; window-level arrows move one second; space, Ctrl/Cmd-Z/Y exclude text inputs | Browser-only keyboard evidence limited |
| Native video/MSE preview/cancellation | Ported | `App.tsx`, `preview.ts`; cleanup aborts request and destroys preview on disposal; persistent diagnostics and `data-preview-offset` retained | No Solid Playwright flow |
| Watched video-position markers | Ported | Set In/Out uses `watchedMediaPosition` from diagnostics and video currentTime | Requires a real playing preview to exercise |
| Thumbnails/waveform/canvas | Ported | `TimelineCanvas.tsx`, asset requests; asset tests pass | None known |
| Project create/load/save/revision conflict | Ported | Save/load/new handlers guard request versions; new aborts loads and resets playhead, mute, diagnostics; persistence tests | Browser 409 flow not automated |
| Dirty/discard protection/recent projects | Ported | `markDirty` covers timeline, project ID, mute, and segment edits; media/load/new confirm discard; beforeunload cleanup | Browser prompt evidence limited |
| CSV/chapters interchange | Ported | Solid App bounded import and export controls through API client | Browser download/import evidence limited |
| Export options/stream selection/polling/cancel/results/errors | Ported | Start/poll/cancel operations use abortable controllers and request-version guards, including DELETE responses; no-segment export is disabled | No browser job lifecycle test |
| Detection request/candidates/poll/cancel/errors | Ported | Start/poll/cancel operations use abortable controllers and request-version guards, including DELETE responses; accepted candidates are removed after insertion | No browser job lifecycle test |
| Hybrid Smart Cut eligibility/messages | Ported | `hybridSmartCutKnownIneligible` disables unsupported option; unsupported-media failures give H.264/CFR/MKV guidance; focused unit test covers message | Browser option-state evidence limited |
| Accessibility/status text | Ported | IDs, labels, live status, semantic controls retained in Solid JSX | Full accessibility run not available |
| Unmount cleanup | Ported | `onCleanup` aborts requests, invalidates versions, clears timers, cleans preview, revokes thumbnail URL | Requires component unmount harness |

## Validation evidence

- `cd client-solid && pnpm run lint` — passed.
- `cd client-solid && pnpm test` — passed, 6 files / 47 tests (including parity helper coverage).
- `cd client-solid && pnpm run build` — passed; 64.18 kB JS / 22.66 kB gzip output.
- `client-solid` has no Playwright script; browser parity checks remain manual/blocked by harness availability.

## Final parity repairs

- Save requests now abort superseded saves and ignore rejected or late responses after project/media changes.
- Terminal detection responses populate candidates immediately; terminal export responses report the correct final status.
- Selection resets both markers to zero; project load restores the saved playhead marker.
- Refresh requests are abortable and disposed with the app.
- Export displays output size, retention, warnings, and selectable declared tracks.
- Unsupported MSE renders the manual timeline fallback.
- Segment controls use a semantic ordered list.
- Preview starts unmuted, matching the reference.

## Focused parity repairs

- Media switching now confirms discard.
- All persisted UI edits route through dirty tracking; undo/redo and mute/project ID are covered.
- Set In/Out reads the watched native video position when preview diagnostics exist.
- Segments support labels, move up/down, and removal.
- Export/detection start, poll, and cancel paths catch request errors and check non-2xx responses.
- Component cleanup aborts outstanding work and invalidates stale callbacks.
- Hybrid Smart Cut is disabled for known-ineligible media.
- Timecode entry and non-text-target keyboard controls are present.
