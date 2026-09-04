import { createSignal, For, Show } from "solid-js";
import { ArrowDown, ArrowUp, Clock3, LocateFixed, Plus, Redo2, Trash2, Undo2 } from "lucide-solid";
import { frameDuration } from "./frame";
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
    previewStatus,
    segmentLabel,
    setSegmentLabel,
    timecode,
    setTimecode,
    setPreviewCenterMs,
    muted,
    setMuted,
    diagnostics,
    timeline,
    setTimeline,
    playheadMs,
    present,
    markDirty,
    saveSettings,
    updateTimeline,
    watchedPosition,
    syncPreviewPosition,
    setMarker,
    addSegment,
    duration,
    removeSegment,
    moveSegment,
    setVideo,
    togglePlayback,
  } = useWorkspace();
  const [selectedSegment, setSelectedSegment] = createSignal<number>();
  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.matches("input, textarea, select, [contenteditable='true']")) return;
    const key = event.key.toLowerCase();
    if (key === "i" || key === "o") {
      event.preventDefault();
      setMarker(
        key === "i" ? "inMs" : "outMs",
        key === "i" ? watchedPosition() : Math.min(duration(), watchedPosition()),
      );
    } else if (key === " ") {
      event.preventDefault();
      togglePlayback();
    } else if (key === "arrowleft" || key === "arrowright") {
      event.preventDefault();
      const step = frameDuration(selected()) || 1000;
      updateTimeline({
        playheadMs:
          key === "arrowleft"
            ? Math.max(0, playheadMs() - step)
            : Math.min(duration(), playheadMs() + step),
      });
      markDirty();
    } else if ((event.ctrlKey || event.metaKey) && key === "z") {
      event.preventDefault();
      const next = event.shiftKey ? redoTimeline(timeline()) : undoTimeline(timeline());
      setTimeline(next);
      setPreviewCenterMs(next.present.playheadMs);
      markDirty();
    } else if (event.ctrlKey && key === "y") {
      event.preventDefault();
      const next = redoTimeline(timeline());
      setTimeline(next);
      setPreviewCenterMs(next.present.playheadMs);
      markDirty();
    }
  };
  return (
    <section
      class="editor-panel card bg-base-200 shadow-sm"
      aria-labelledby="timeline-heading"
      onKeyDown={handleKeyDown}
    >
      <div class="panel-heading">
        <h2 id="timeline-heading" tabIndex={-1} class="card-title text-base">
          Timeline
        </h2>
        <span class="badge badge-ghost">{present().segments.length} segments</span>
      </div>
      <Show
        when={selected()}
        fallback={
          <section class="editor-onboarding" aria-labelledby="editor-onboarding-heading">
            <h3 id="editor-onboarding-heading">Choose a video to begin</h3>
            <p>Select a video from the Media library to unlock the editing workspace.</p>
            <div class="locked-workflows" aria-label="Editor workflows">
              <p>
                <button disabled title="Select a video before opening preview.">
                  Preview
                </button>{" "}
                Select a video first.
              </p>
              <p>
                <button disabled title="Select a video before editing the timeline.">
                  Timeline editing
                </button>{" "}
                Select a video first.
              </p>
              <p>
                <button disabled title="Select a video before running detection.">
                  Detection
                </button>{" "}
                Select a video first.
              </p>
              <p>
                <button disabled title="Select a video before exporting.">
                  Export
                </button>{" "}
                Select a video first.
              </p>
            </div>
          </section>
        }
      >
        {(item) => (
          <>
            <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
              <p class="m-0 truncate">
                <strong>{item().name}</strong> · {formatTime(item().durationMs, duration())}
              </p>
              <span class="badge badge-outline">{formatTime(duration(), duration())}</span>
            </div>
            <p id="timeline-description">
              Playhead {formatTime(playheadMs(), duration())}. In marker{" "}
              {formatTime(present().inMs, duration())}. Out marker{" "}
              {formatTime(present().outMs, duration())}.{" "}
              {present().segments.length
                ? `${present().segments.length} segment${present().segments.length === 1 ? "" : "s"} selected.`
                : "No segments selected."}
            </p>
            <PreviewPlayer
              selected={selected}
              duration={duration}
              playheadMs={playheadMs}
              muted={muted}
              previewStatus={previewStatus}
              diagnostics={diagnostics}
              setMuted={(value) => setMuted(value)}
              saveSettings={saveSettings}
              setVideo={setVideo}
              syncPreviewPosition={syncPreviewPosition}
              togglePlayback={togglePlayback}
              updateTimeline={(changes) => updateTimeline(changes)}
              markDirty={markDirty}
            />
            <Timeline />
            {assetStatus() && (
              <div class="alert alert-info py-2 mb-3" role="status">
                {assetStatus()}
              </div>
            )}
            <input
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
            <p>
              In: {formatTime(present().inMs, duration())} · Out:{" "}
              {formatTime(present().outMs, duration())}
            </p>
            <div
              class="editor-controls flex flex-wrap items-end gap-3"
              aria-label="Editing controls"
            >
              <div class="control-group flex flex-wrap items-center gap-2" aria-label="History">
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
                <button
                  class="btn btn-sm"
                  aria-keyshortcuts="I"
                  onClick={() => setMarker("inMs", watchedPosition())}
                >
                  <LocateFixed size={16} aria-hidden="true" /> Set in
                </button>
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
                  <Plus size={16} aria-hidden="true" /> Add segment
                </button>
              </div>
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
                  Go to timecode
                </button>
                <label>
                  Segment label{" "}
                  <input
                    value={segmentLabel()}
                    onInput={(event) => setSegmentLabel(event.currentTarget.value)}
                  />
                </label>
              </div>
            </div>
            <p id="add-segment-help" class="control-help" role="status">
              {present().inMs >= present().outMs
                ? "Set a start before the end to add a segment."
                : "Marker range is ready to add."}
            </p>
            <p class="control-help">
              Keyboard: Space plays or pauses; arrows step frames; I/O set markers; Ctrl/Cmd+Z
              undoes.
            </p>
            <ol aria-label="Selected segments">
              <For each={present().segments}>
                {(segment, index) => (
                  <li
                    class={selectedSegment() === index() ? "segment-row selected" : "segment-row"}
                  >
                    <button
                      type="button"
                      aria-label={`Select segment ${index() + 1}`}
                      aria-pressed={selectedSegment() === index()}
                      onClick={() => {
                        setSelectedSegment(index());
                      }}
                    >
                      Select
                    </button>
                    <strong>Segment {index() + 1}</strong> · {segment.label ?? "Unlabelled"}:{" "}
                    <span>
                      {formatTime(segment.startMs, duration())} –{" "}
                      {formatTime(segment.endMs, duration())}
                    </span>{" "}
                    <span class="segment-duration">
                      ({formatTime(segment.endMs - segment.startMs, duration())} duration)
                    </span>{" "}
                    <button
                      class="btn btn-sm btn-square"
                      title={`Move segment ${index() + 1} up`}
                      aria-label={`Move segment ${index() + 1} up`}
                      onClick={() => moveSegment(index(), -1)}
                      disabled={index() === 0}
                    >
                      <ArrowUp size={16} aria-hidden="true" />
                    </button>{" "}
                    <button
                      class="btn btn-sm btn-square"
                      title={`Move segment ${index() + 1} down`}
                      aria-label={`Move segment ${index() + 1} down`}
                      onClick={() => moveSegment(index(), 1)}
                      disabled={index() === present().segments.length - 1}
                    >
                      <ArrowDown size={16} aria-hidden="true" />
                    </button>{" "}
                    <button
                      class="btn btn-sm btn-error btn-outline"
                      onClick={() => removeSegment(index())}
                    >
                      <Trash2 size={16} aria-hidden="true" /> Remove segment
                    </button>
                  </li>
                )}
              </For>
            </ol>
          </>
        )}
      </Show>
    </section>
  );
}
