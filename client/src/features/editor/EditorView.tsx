import { createSignal, onCleanup, Show } from "solid-js";
import { Clock3, LocateFixed, Plus, Redo2, Undo2 } from "lucide-solid";
import { redoTimeline, undoTimeline } from "./timeline";
import { Timeline } from "./Timeline";
import { formatTime, parseTimecode } from "../preview/model";
import { PreviewPlayer } from "../preview/PreviewPlayer";
import { useWorkspace } from "../app/WorkspaceContext";

export function EditorView() {
  const {
    selected,
    setStatus,
    assetStatus,
    segmentLabel,
    setSegmentLabel,
    timecode,
    setTimecode,
    setPreviewCenterMs,
    timeline,
    setTimeline,
    playheadMs,
    present,
    markDirty,
    updateTimeline,
    watchedPosition,
    setMarker,
    addSegment,
    duration,
  } = useWorkspace();
  const narrowViewport = window.matchMedia("(max-width: 700px)");
  const [secondaryOpen, setSecondaryOpen] = createSignal(!narrowViewport.matches);
  const syncSecondaryControls = () => setSecondaryOpen(!narrowViewport.matches);
  narrowViewport.addEventListener("change", syncSecondaryControls);
  onCleanup(() => narrowViewport.removeEventListener("change", syncSecondaryControls));
  return (
    <section class="editor-panel card bg-base-200 shadow-sm" aria-labelledby="timeline-heading">
      <div class="panel-heading">
        <h2 id="timeline-heading" tabIndex={-1} class="card-title text-base">
          Timeline
        </h2>
      </div>
      <Show
        when={selected()}
        fallback={
          <section class="editor-onboarding" aria-labelledby="editor-onboarding-heading">
            <h3 id="editor-onboarding-heading">Choose a video to begin</h3>
            <p>Select a video from the Media library to unlock the editing workspace.</p>
            <button
              class="btn btn-primary"
              type="button"
              onClick={() => document.getElementById("media-heading")?.focus()}
            >
              Choose a video
            </button>
          </section>
        }
      >
        {(item) => (
          <>
            <div class="selected-media-summary" aria-label="Selected media">
              <strong>{item().name}</strong>
              <span>{formatTime(item().durationMs, duration())}</span>
            </div>
            <p id="timeline-description" class="sr-only">
              Playhead {formatTime(playheadMs(), duration())}. In marker{" "}
              {formatTime(present().inMs, duration())}. Out marker{" "}
              {formatTime(present().outMs, duration())}.{" "}
              {present().segments.length
                ? `${present().segments.length} segment${present().segments.length === 1 ? "" : "s"} selected.`
                : "No segments selected."}
            </p>
            <PreviewPlayer />
            <Timeline />
            {assetStatus() && (
              <div class="alert alert-info py-2 mb-3" role="status">
                {assetStatus()}
              </div>
            )}
            <input
              class="accessible-playhead"
              id="playhead"
              aria-label="Timeline playhead"
              aria-valuetext={`${formatTime(playheadMs(), duration())} of ${formatTime(duration(), duration())}`}
              aria-keyshortcuts="ArrowLeft ArrowRight"
              type="range"
              min="0"
              max={duration()}
              step="1"
              value={playheadMs()}
              onInput={(event) => {
                const value = Number(event.currentTarget.value);
                updateTimeline({ playheadMs: value });
                markDirty();
              }}
            />
            <div
              class="editor-controls flex flex-wrap items-end gap-3"
              aria-label="Editing controls"
            >
              <div
                class="control-group history-controls flex flex-wrap items-center gap-2"
                aria-label="History"
              >
                <button
                  class="btn btn-sm btn-square"
                  title="Undo"
                  aria-label="Undo"
                  disabled={!timeline().past.length}
                  onClick={() => {
                    const next = undoTimeline(timeline());
                    setTimeline(next);
                    setPreviewCenterMs(next.present.playheadMs);
                    markDirty();
                  }}
                  aria-keyshortcuts="Control+Z Meta+Z"
                >
                  <Undo2 size={16} aria-hidden="true" />
                  <span class="sr-only">Undo</span>
                </button>
                <button
                  class="btn btn-sm btn-square"
                  title="Redo"
                  aria-label="Redo"
                  disabled={!timeline().future.length}
                  onClick={() => {
                    const next = redoTimeline(timeline());
                    setTimeline(next);
                    setPreviewCenterMs(next.present.playheadMs);
                    markDirty();
                  }}
                  aria-keyshortcuts="Control+Y Meta+Shift+Z"
                >
                  <Redo2 size={16} aria-hidden="true" />
                  <span class="sr-only">Redo</span>
                </button>
              </div>
              <div
                class="control-group marking-controls flex flex-wrap items-center gap-2"
                aria-label="Marking controls"
              >
                <span class="marker-value">In: {present().inMs ? formatTime(present().inMs, duration()) : "Unset"}</span>
                <button
                  class="btn btn-sm"
                  aria-keyshortcuts="I"
                  onClick={() => setMarker("inMs", watchedPosition())}
                >
                  <LocateFixed size={16} aria-hidden="true" /> Set in
                </button>
                <span class="marker-value">Out: {present().outMs ? formatTime(present().outMs, duration()) : "Unset"}</span>
                <button
                  class="btn btn-sm"
                  aria-keyshortcuts="O"
                  onClick={() => setMarker("outMs", Math.min(duration(), watchedPosition()))}
                >
                  <LocateFixed size={16} aria-hidden="true" /> Set out
                </button>
                <button
                  class="btn btn-sm btn-primary"
                  onClick={addSegment}
                  disabled={present().inMs >= present().outMs}
                  aria-describedby="add-segment-help"
                >
                  <Plus size={16} aria-hidden="true" /> Add cut
                </button>
              </div>
              <details
                class="secondary-controls"
                open={secondaryOpen()}
                onToggle={(event) => setSecondaryOpen(event.currentTarget.open)}
              >
                <summary>More editing actions</summary>
                <div
                  class="control-group flex flex-wrap items-center gap-2"
                  aria-label="Segment details"
                >
                  <label class="input input-sm">
                    <Clock3 size={16} aria-hidden="true" />
                    <span class="sr-only">Timecode</span>{" "}
                    <input
                      value={timecode()}
                      placeholder="00:00.000"
                      onInput={(event) => setTimecode(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") { setTimecode(formatTime(playheadMs(), duration())); event.currentTarget.blur(); }
                        if (event.key === "Enter") {
                          const value = parseTimecode(timecode());
                          if (value === undefined || value > duration()) setStatus("Invalid timecode.");
                          else { updateTimeline({ playheadMs: value }); event.currentTarget.blur(); }
                        }
                      }}
                    />
                  </label>
                  <button
                    class="btn btn-sm"
                    onClick={() => {
                      const value = parseTimecode(timecode());
                      if (value === undefined || value > duration())
                        return setStatus("Invalid timecode.");
                      updateTimeline({ playheadMs: value });
                    }}
                  >
                    Confirm timecode
                  </button>
                  <label>
                    Segment label{" "}
                    <input
                      value={segmentLabel()}
                      onInput={(event) => setSegmentLabel(event.currentTarget.value)}
                    />
                  </label>
                </div>
              </details>
            </div>
            <Show when={present().inMs >= present().outMs}>
              <p id="add-segment-help" class="control-help" role="status">
                Set In, then Out, to add a cut.
              </p>
            </Show>
            <details class="shortcut-help">
              <summary>Shortcuts</summary>
              <p class="control-help">
                Space plays or pauses; arrows step frames; I/O set markers; Ctrl/Cmd+Z undoes.
              </p>
            </details>
            <p class="control-help">Manage saved cuts in the Cuts task.</p>
          </>
        )}
      </Show>
    </section>
  );
}
