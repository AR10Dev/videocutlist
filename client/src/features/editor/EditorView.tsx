import { For, Show } from "solid-js";
import { frameDuration } from "./frame";
import { redoTimeline, undoTimeline } from "./timeline";
import { TimelineCanvas } from "./TimelineCanvas";
import { viewportScale } from "../preview/assets";
import { canStreamPreview, formatTime, parseTimecode } from "../preview/model";
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
    thumbnailURL,
    waveform,
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
  } = useWorkspace();
  return (
    <section class="editor-panel" aria-labelledby="timeline-heading">
      <h2 id="timeline-heading">Timeline</h2>
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
            <p>
              <strong>{item().name}</strong> · {formatTime(item().durationMs, duration())}
            </p>
            <p id="timeline-description">
              Playhead {formatTime(playheadMs(), duration())}. In marker{" "}
              {formatTime(present().inMs, duration())}. Out marker{" "}
              {formatTime(present().outMs, duration())}.{" "}
              {present().segments.length
                ? `${present().segments.length} segment${present().segments.length === 1 ? "" : "s"} selected.`
                : "No segments selected."}
            </p>
            <Show
              when={canStreamPreview()}
              fallback={
                <p class="preview-unavailable" role="status">
                  Preview is unavailable in this browser. Use the timeline controls to set markers
                  manually.
                </p>
              }
            >
              <video
                ref={(element) => {
                  setVideo(element);
                }}
                controls
                muted={muted()}
                aria-label="Preview player"
                data-preview-offset={diagnostics()?.offsetMs ?? 0}
                onTimeUpdate={(event) => syncPreviewPosition(event.currentTarget.currentTime)}
                onSeeking={(event) => syncPreviewPosition(event.currentTarget.currentTime)}
                onSeeked={(event) => syncPreviewPosition(event.currentTarget.currentTime)}
              />
            </Show>
            <div
              class="timeline-visual"
              role="group"
              aria-labelledby="timeline-heading timeline-description"
              style={{ width: `${viewportScale(present().zoom) * 100}%` }}
            >
              <TimelineCanvas thumbnailURL={thumbnailURL()} waveform={waveform()} />
              <span
                class="timeline-overlay timeline-in"
                style={{
                  transform: `translateX(${(present().inMs / duration()) * 100}%)`,
                }}
                aria-label="In marker"
              />
              <span
                class="timeline-overlay timeline-out"
                style={{
                  transform: `translateX(${(present().outMs / duration()) * 100}%)`,
                }}
                aria-label="Out marker"
              />
              <For each={present().segments}>
                {(segment) => (
                  <span
                    class="timeline-segment"
                    style={{
                      left: `${(segment.startMs / duration()) * 100}%`,
                      width: `${((segment.endMs - segment.startMs) / duration()) * 100}%`,
                    }}
                    aria-label={`Segment ${formatTime(segment.startMs, duration())} to ${formatTime(segment.endMs, duration())}`}
                  />
                )}
              </For>
              <span
                class="timeline-overlay timeline-playhead"
                style={{
                  transform: `translateX(${(playheadMs() / duration()) * 100}%)`,
                }}
                aria-label="Playhead"
              />
            </div>
            {assetStatus() && <p role="status">{assetStatus()}</p>}
            <input
              id="playhead"
              aria-label="Timeline playhead"
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
            <div class="controls">
              <button
                onClick={() => {
                  const step = frameDuration(selected());
                  updateTimeline({
                    playheadMs: Math.max(0, playheadMs() - (step || 1000)),
                  });
                  markDirty();
                }}
              >
                Previous frame
              </button>
              <button
                onClick={() => {
                  updateTimeline({
                    playheadMs: Math.min(
                      duration(),
                      playheadMs() + (frameDuration(selected()) || 1000),
                    ),
                  });
                  markDirty();
                }}
              >
                Next frame
              </button>
              <button
                disabled={!timeline().past.length}
                onClick={() => {
                  const next = undoTimeline(timeline());
                  setTimeline(next);
                  setPreviewCenterMs(next.present.playheadMs);
                  markDirty();
                }}
              >
                Undo
              </button>
              <button
                disabled={!timeline().future.length}
                onClick={() => {
                  const next = redoTimeline(timeline());
                  setTimeline(next);
                  setPreviewCenterMs(next.present.playheadMs);
                  markDirty();
                }}
              >
                Redo
              </button>
              <button onClick={addSegment}>Add In/Out segment</button>
              <button onClick={() => setMarker("inMs", watchedPosition())}>Set In marker</button>
              <button onClick={() => setMarker("outMs", Math.min(duration(), watchedPosition()))}>
                Set Out marker
              </button>
              <label>
                Timecode{" "}
                <input
                  value={timecode()}
                  placeholder="0:00.000"
                  onInput={(event) => setTimecode(event.currentTarget.value)}
                />
              </label>
              <button
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
            <ol aria-label="Selected segments">
              <For each={present().segments}>
                {(segment, index) => (
                  <li>
                    <strong>Segment {index() + 1}</strong> · {segment.label ?? "Unlabelled"}:{" "}
                    <span>
                      {formatTime(segment.startMs, duration())} –{" "}
                      {formatTime(segment.endMs, duration())}
                    </span>{" "}
                    <span class="segment-duration">
                      ({formatTime(segment.endMs - segment.startMs, duration())} duration)
                    </span>{" "}
                    <button
                      aria-label={`Move segment ${index() + 1} up`}
                      onClick={() => moveSegment(index(), -1)}
                      disabled={index() === 0}
                    >
                      Move up
                    </button>{" "}
                    <button
                      aria-label={`Move segment ${index() + 1} down`}
                      onClick={() => moveSegment(index(), 1)}
                      disabled={index() === present().segments.length - 1}
                    >
                      Move down
                    </button>{" "}
                    <button onClick={() => removeSegment(index())}>Remove segment</button>
                  </li>
                )}
              </For>
            </ol>
            <label>
              <input
                type="checkbox"
                checked={muted()}
                onChange={(event) => {
                  const value = event.currentTarget.checked;
                  setMuted(value);
                  saveSettings({ muted: value });
                  markDirty();
                }}
              />{" "}
              Mute preview
            </label>
          </>
        )}
      </Show>
    </section>
  );
}
