import { createSignal, For } from "solid-js";
import { animate } from "motion";
import { viewportScale } from "../preview/assets";
import { formatTime } from "../preview/model";
import { useWorkspace } from "../app/WorkspaceContext";
import { TimelineCanvas } from "./TimelineCanvas";
import { timelineTimeFromPointer } from "./timeline";

export function Timeline() {
  const { duration, present, playheadMs, thumbnailURL, waveform, updateTimeline, setMarker, activeSegmentIndex, setActiveSegmentIndex } =
    useWorkspace();
  const [dragTarget, setDragTarget] = createSignal<"playheadMs" | "inMs" | "outMs">();
  let timeline: HTMLDivElement | undefined;

  const positionFromPointer = (
    event: { clientX: number },
    target: "playheadMs" | "inMs" | "outMs" = "playheadMs",
  ) => {
    if (!timeline) return;
    const bounds = timeline.getBoundingClientRect();
    const value = timelineTimeFromPointer(event.clientX, bounds.left, bounds.width, duration());
    if (target === "playheadMs") updateTimeline({ playheadMs: value });
    else if (target === "inMs") setMarker(target, Math.min(value, present().outMs));
    else setMarker(target, Math.max(value, present().inMs));
  };
  const beginDrag = (target: "playheadMs" | "inMs" | "outMs", event: PointerEvent) => {
    event.preventDefault();
    if (target !== "playheadMs") event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDragTarget(target);
    positionFromPointer(event, target);
    if (timeline && !window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      animate(timeline, { scaleY: 0.985 }, { duration: 0.1 });
  };
  const finishSeek = () => {
    setDragTarget();
    if (timeline) animate(timeline, { scaleY: 1 }, { duration: 0.1 });
  };

  const zoom = () => present().zoom;
  return (
    <div class="timeline-scroll" role="group" aria-label="Timeline lanes">
      <div class="timeline-toolbar" aria-label="Timeline zoom controls">
        <button type="button" class="btn btn-sm" aria-label="Zoom out" onClick={() => updateTimeline({ zoom: Math.max(1, zoom() / 2) })}>−</button>
        <button type="button" class="btn btn-sm" aria-label="Fit timeline" onClick={() => updateTimeline({ zoom: 1 })}>Fit</button>
        <span aria-label="Timeline zoom level">{zoom()}×</span>
        <button type="button" class="btn btn-sm" aria-label="Zoom in" onClick={() => updateTimeline({ zoom: Math.min(16, zoom() * 2) })}>+</button>
      </div>
      <div
        ref={(element) => (timeline = element)}
        class="timeline-visual"
        style={{ width: `${viewportScale(present().zoom) * 100}%` }}
        onClick={positionFromPointer}
        onPointerDown={(event) => beginDrag("playheadMs", event)}
        onPointerMove={(event) => {
          const target = dragTarget();
          if (target) positionFromPointer(event, target);
        }}
        onPointerUp={finishSeek}
        onPointerCancel={finishSeek}
        role="slider"
        tabIndex={0}
        aria-label="Timeline position"
        aria-valuemin="0"
        aria-valuemax={duration()}
        aria-valuenow={playheadMs()}
        aria-valuetext={`${formatTime(playheadMs(), duration())} of ${formatTime(duration(), duration())}`}
      >
        <div class="timeline-lane timeline-ruler" role="img" aria-label="Timeline ruler">
          <span>{formatTime(0, duration())}</span>
          <span>{formatTime(duration() / zoom() / 2, duration())}</span>
          <span>{formatTime(duration() / zoom(), duration())}</span>
        </div>
        <div class="timeline-lane timeline-thumbnails" role="img" aria-label="Thumbnail lane">
          <TimelineCanvas thumbnailURL={thumbnailURL()} waveform={[]} lane="thumbnail" />
        </div>
        <div class="timeline-lane timeline-waveform" role="img" aria-label="Waveform lane">
          <TimelineCanvas waveform={waveform()} lane="waveform" />
        </div>
        <div class="timeline-overlays" aria-hidden="true">
          <span
            class="timeline-overlay timeline-in"
            style={{ left: `${(present().inMs / duration()) * 100}%` }}
            onPointerDown={(event) => beginDrag("inMs", event)}
            onClick={(event) => event.stopPropagation()}
          />
          <span
            class="timeline-overlay timeline-out"
            style={{ left: `${(present().outMs / duration()) * 100}%` }}
            onPointerDown={(event) => beginDrag("outMs", event)}
            onClick={(event) => event.stopPropagation()}
          />
          <For each={present().segments}>
            {(segment, index) => (
              <span
                class={`timeline-segment ${activeSegmentIndex() === index() ? "is-active" : ""}`}
                role="button"
                aria-label={`Select cut ${index() + 1}`}
                onClick={(event) => { event.stopPropagation(); setActiveSegmentIndex(index()); }}
                style={{
                  left: `${(segment.startMs / duration()) * 100}%`,
                  width: `${((segment.endMs - segment.startMs) / duration()) * 100}%`,
                }}
              />
            )}
          </For>
          <span
            class="timeline-overlay timeline-playhead"
            style={{ left: `${(playheadMs() / duration()) * 100}%` }}
          />
        </div>
        {dragTarget() && (
          <output class="timeline-timecode">{formatTime(playheadMs(), duration())}</output>
        )}
      </div>
    </div>
  );
}
