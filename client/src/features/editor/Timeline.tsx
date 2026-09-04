import { createSignal, For } from "solid-js";
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

  const positionFromPointer = (event: PointerEvent) => {
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
  };
  const finishSeek = () => {
    setDragging(false);
    markDirty();
  };

  return (
    <div class="timeline-scroll" ref={(element) => (timeline = element)}>
      <div
        class="timeline-visual"
        style={{ width: `${viewportScale(present().zoom) * 100}%` }}
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
        <div class="timeline-lane timeline-ruler" aria-hidden="true">
          <span>{formatTime(0, duration())}</span>
          <span>{formatTime(duration() / 2, duration())}</span>
          <span>{formatTime(duration(), duration())}</span>
        </div>
        <div class="timeline-lane timeline-thumbnails">
          <TimelineCanvas thumbnailURL={thumbnailURL()} waveform={[]} lane="thumbnail" />
        </div>
        <div class="timeline-lane timeline-waveform">
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
