import { createSignal, For } from "solid-js";
import { animate } from "motion";
import { viewportScale } from "../preview/assets";
import { formatTime } from "../preview/model";
import { useWorkspace } from "../app/WorkspaceContext";
import { TimelineCanvas } from "./TimelineCanvas";
import { timelineTimeFromPointer } from "./timeline";

export function Timeline() {
  const { duration, present, playheadMs, thumbnailURL, waveform, updateTimeline, markDirty } =
    useWorkspace();
  const [dragging, setDragging] = createSignal(false);
  const [selectedSegment, setSelectedSegment] = createSignal<number>();
  let timeline: HTMLDivElement | undefined;

  const positionFromPointer = (event: { clientX: number }) => {
    if (!timeline) return;
    const bounds = timeline.getBoundingClientRect();
    updateTimeline({
      playheadMs: timelineTimeFromPointer(event.clientX, bounds.left, bounds.width, duration()),
    });
  };
  const startSeek = (event: PointerEvent) => {
    event.preventDefault();
    timeline?.setPointerCapture(event.pointerId);
    setDragging(true);
    positionFromPointer(event);
    if (timeline && !window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      animate(timeline, { scaleY: 0.985 }, { duration: 0.1 });
  };
  const finishSeek = () => {
    setDragging(false);
    markDirty();
    if (timeline) animate(timeline, { scaleY: 1 }, { duration: 0.1 });
  };

  return (
    <div class="timeline-scroll" role="group" aria-label="Timeline lanes">
      <div
        ref={(element) => (timeline = element)}
        class="timeline-visual"
        style={{ width: `${viewportScale(present().zoom) * 100}%` }}
        onClick={positionFromPointer}
        onPointerDown={startSeek}
        onPointerMove={(event) => dragging() && positionFromPointer(event)}
        onPointerUp={finishSeek}
        onPointerCancel={finishSeek}
        role="slider"
        aria-label="Timeline position"
        aria-valuemin="0"
        aria-valuemax={duration()}
        aria-valuenow={playheadMs()}
        aria-valuetext={`${formatTime(playheadMs(), duration())} of ${formatTime(duration(), duration())}`}
      >
        <div class="timeline-lane timeline-ruler" role="img" aria-label="Timeline ruler">
          <span>{formatTime(0, duration())}</span>
          <span>{formatTime(duration() / 2, duration())}</span>
          <span>{formatTime(duration(), duration())}</span>
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
          />
          <span
            class="timeline-overlay timeline-out"
            style={{ left: `${(present().outMs / duration()) * 100}%` }}
          />
          <For each={present().segments}>
            {(segment, index) => (
              <span
                class={`timeline-segment ${selectedSegment() === index() ? "selected" : ""}`}
                style={{
                  left: `${(segment.startMs / duration()) * 100}%`,
                  width: `${((segment.endMs - segment.startMs) / duration()) * 100}%`,
                }}
                onPointerDown={() => setSelectedSegment(index())}
              />
            )}
          </For>
          <span
            class="timeline-overlay timeline-playhead"
            style={{ left: `${(playheadMs() / duration()) * 100}%` }}
          />
        </div>
        {dragging() && (
          <output class="timeline-timecode">{formatTime(playheadMs(), duration())}</output>
        )}
      </div>
    </div>
  );
}
