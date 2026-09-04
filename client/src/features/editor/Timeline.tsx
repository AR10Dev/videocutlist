import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { animate } from "motion";
import { viewportScale } from "../preview/assets";
import { formatTime } from "../preview/model";
import { useWorkspace } from "../app/WorkspaceContext";
import { TimelineCanvas } from "./TimelineCanvas";
import { timelineTimeFromPointer, visibleTimelineWindow } from "./timeline";

type DragTarget =
  | { kind: "playhead" | "draft-in" | "draft-out" }
  | { kind: "segment-start" | "segment-end"; index: number }
  | { kind: "segment-body"; index: number; offsetMs: number };

export function Timeline() {
  const workspace = useWorkspace();
  const [dragTarget, setDragTarget] = createSignal<DragTarget>();
  const [hoverMs, setHoverMs] = createSignal<number>();
  const [showThumbnails, setShowThumbnails] = createSignal(true);
  const [showWaveform, setShowWaveform] = createSignal(true);
  const [followPlayback, setFollowPlayback] = createSignal(false);
  const [visibleWindow, setVisibleWindow] = createSignal({
    startMs: 0,
    endMs: workspace.duration(),
  });
  let scroller: HTMLDivElement | undefined;
  let timeline: HTMLDivElement | undefined;
  let dragStart: ReturnType<typeof workspace.timeline> | undefined;

  const pointerTime = (clientX: number) => {
    if (!timeline) return 0;
    const bounds = timeline.getBoundingClientRect();
    return timelineTimeFromPointer(clientX, bounds.left, bounds.width, workspace.duration());
  };
  const updateWindow = () => {
    if (!scroller || !timeline) return;
    setVisibleWindow(
      visibleTimelineWindow(
        scroller.scrollLeft,
        scroller.clientWidth,
        timeline.getBoundingClientRect().width,
        workspace.duration(),
      ),
    );
  };
  const positionFromPointer = (clientX: number, target: DragTarget = { kind: "playhead" }) => {
    const value = pointerTime(clientX);
    setHoverMs(value);
    if (target.kind === "playhead") workspace.updateTimeline({ playheadMs: value });
    else if (target.kind === "draft-in")
      workspace.setMarker(
        "inMs",
        Math.min(value, workspace.present().outMs ?? workspace.duration()),
      );
    else if (target.kind === "draft-out")
      workspace.setMarker("outMs", Math.max(value, workspace.present().inMs ?? 0));
    else if (target.kind === "segment-start")
      workspace.updateSegment(target.index, { boundary: "start", valueMs: value });
    else if (target.kind === "segment-end")
      workspace.updateSegment(target.index, { boundary: "end", valueMs: value });
    else if (target.kind === "segment-body")
      workspace.updateSegment(target.index, { startMs: value - target.offsetMs });
  };
  const beginDrag = (target: DragTarget, event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragStart ??= workspace.timeline();
    setDragTarget(target);
    positionFromPointer(event.clientX, target);
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Window-level pointer handlers keep dragging available when capture is unsupported.
    }
    if (timeline && !globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches)
      animate(timeline, { scaleY: 0.985 }, { duration: 0.1 });
  };
  const beginMouseDrag = (target: DragTarget, event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragStart ??= workspace.timeline();
    setDragTarget(target);
    positionFromPointer(event.clientX, target);
  };
  const finishDrag = () => {
    const target = dragTarget();
    const original = dragStart;
    const edited = workspace.present();
    dragStart = undefined;
    setDragTarget();
    if (original && target) {
      workspace.setTimeline(original);
      if (target.kind === "playhead") workspace.updateTimeline({ playheadMs: edited.playheadMs });
      else if (target.kind === "draft-in") workspace.updateTimeline({ inMs: edited.inMs });
      else if (target.kind === "draft-out") workspace.updateTimeline({ outMs: edited.outMs });
      else workspace.updateTimeline({ segments: edited.segments });
    }
    if (timeline) animate(timeline, { scaleY: 1 }, { duration: 0.1 });
  };
  const setZoom = (zoom: number) => {
    const anchorMs = hoverMs() ?? workspace.playheadMs();
    workspace.updateTimeline({ zoom: Math.max(1, Math.min(16, zoom)) });
    requestAnimationFrame(() => {
      if (scroller && timeline)
        scroller.scrollLeft =
          (anchorMs / workspace.duration()) * timeline.clientWidth - scroller.clientWidth / 2;
      updateWindow();
    });
  };

  createEffect(() => {
    setVisibleWindow({ startMs: 0, endMs: workspace.duration() / workspace.present().zoom });
    requestAnimationFrame(updateWindow);
  });
  const handlePointerMove = (event: PointerEvent | MouseEvent) => {
    const target = dragTarget();
    if (target) positionFromPointer(event.clientX, target);
  };
  globalThis.addEventListener("pointermove", handlePointerMove);
  globalThis.addEventListener("pointerup", finishDrag);
  globalThis.addEventListener("mousemove", handlePointerMove);
  globalThis.addEventListener("mouseup", finishDrag);
  onCleanup(() => {
    globalThis.removeEventListener("pointermove", handlePointerMove);
    globalThis.removeEventListener("pointerup", finishDrag);
    globalThis.removeEventListener("mousemove", handlePointerMove);
    globalThis.removeEventListener("mouseup", finishDrag);
  });

  createEffect(() => {
    if (!followPlayback() || !scroller || !timeline || workspace.present().zoom <= 1) return;
    const x = (workspace.playheadMs() / workspace.duration()) * timeline.clientWidth;
    if (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth)
      scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 2);
  });

  const zoom = () => workspace.present().zoom;
  return (
    <div class="timeline-wrap">
      <div class="timeline-toolbar" aria-label="Timeline controls">
        <button
          type="button"
          class="btn btn-sm"
          aria-label="Zoom out"
          disabled={zoom() <= 1}
          onClick={() => setZoom(zoom() / 2)}
        >
          −
        </button>
        <button
          type="button"
          class="btn btn-sm"
          aria-label="Fit timeline"
          onClick={() => setZoom(1)}
        >
          Fit
        </button>
        <span aria-label="Timeline zoom level">{zoom()}×</span>
        <button
          type="button"
          class="btn btn-sm"
          aria-label="Zoom in"
          disabled={zoom() >= 16}
          onClick={() => setZoom(zoom() * 2)}
        >
          +
        </button>
        <label>
          <input
            type="checkbox"
            checked={showThumbnails()}
            onChange={(event) => setShowThumbnails(event.currentTarget.checked)}
          />{" "}
          Thumbnails
        </label>
        <label>
          <input
            type="checkbox"
            checked={showWaveform()}
            onChange={(event) => setShowWaveform(event.currentTarget.checked)}
          />{" "}
          Waveform
        </label>
        <label>
          <input
            type="checkbox"
            checked={followPlayback()}
            onChange={(event) => setFollowPlayback(event.currentTarget.checked)}
          />{" "}
          Follow
        </label>
      </div>
      <div
        ref={(element) => (scroller = element)}
        class="timeline-scroll"
        role="group"
        aria-label="Timeline lanes"
        onScroll={updateWindow}
        onWheel={(event) => {
          if (zoom() <= 1 || !scroller) return;
          if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) {
            event.preventDefault();
            scroller.scrollLeft += event.deltaX || event.deltaY;
          }
        }}
      >
        <div
          ref={(element) => (timeline = element)}
          class="timeline-visual"
          style={{ width: `${viewportScale(zoom()) * 100}%` }}
          onClick={(event) => {
            if (!(event.target as HTMLElement).closest(".timeline-overlay, .timeline-segment"))
              positionFromPointer(event.clientX);
          }}
          onPointerDown={(event) => {
            if (!(event.target as HTMLElement).closest(".timeline-overlay, .timeline-segment"))
              beginDrag({ kind: "playhead" }, event);
          }}
          onPointerMove={(event) => {
            setHoverMs(pointerTime(event.clientX));
            const target = dragTarget();
            if (target) positionFromPointer(event.clientX, target);
          }}
          onPointerLeave={() => !dragTarget() && setHoverMs()}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onKeyDown={(event) => {
            if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              workspace.updateTimeline({
                playheadMs: event.key === "Home" ? 0 : workspace.duration(),
              });
            }
          }}
          role="slider"
          tabIndex={0}
          aria-label="Timeline position"
          aria-valuemin="0"
          aria-valuemax={workspace.duration()}
          aria-valuenow={workspace.playheadMs()}
          aria-valuetext={`${formatTime(workspace.playheadMs(), workspace.duration())} of ${formatTime(workspace.duration(), workspace.duration())}`}
        >
          <div class="timeline-lane timeline-ruler" role="img" aria-label="Timeline ruler">
            <span>{formatTime(visibleWindow().startMs, workspace.duration())}</span>
            <span>
              {formatTime(
                (visibleWindow().startMs + visibleWindow().endMs) / 2,
                workspace.duration(),
              )}
            </span>
            <span>{formatTime(visibleWindow().endMs, workspace.duration())}</span>
          </div>
          <Show when={showThumbnails()}>
            <div class="timeline-lane timeline-thumbnails" role="img" aria-label="Thumbnail lane">
              <TimelineCanvas
                thumbnailURL={workspace.thumbnailURL()}
                waveform={[]}
                lane="thumbnail"
              />
            </div>
          </Show>
          <Show when={showWaveform()}>
            <div class="timeline-lane timeline-waveform" role="img" aria-label="Waveform lane">
              <TimelineCanvas waveform={workspace.waveform()} lane="waveform" />
            </div>
          </Show>
          <div class="timeline-overlays">
            <Show when={workspace.present().inMs !== undefined}>
              <span
                class="timeline-overlay timeline-in"
                aria-label="In marker"
                style={{ left: `${(workspace.present().inMs! / workspace.duration()) * 100}%` }}
                onPointerDown={(event) => beginDrag({ kind: "draft-in" }, event)}
                onMouseDown={(event) => beginMouseDrag({ kind: "draft-in" }, event)}
                onPointerMove={(event) =>
                  dragTarget() && positionFromPointer(event.clientX, dragTarget())
                }
                onPointerUp={finishDrag}
              />
            </Show>
            <Show when={workspace.present().outMs !== undefined}>
              <span
                class="timeline-overlay timeline-out"
                aria-label="Out marker"
                style={{ left: `${(workspace.present().outMs! / workspace.duration()) * 100}%` }}
                onPointerDown={(event) => beginDrag({ kind: "draft-out" }, event)}
                onMouseDown={(event) => beginMouseDrag({ kind: "draft-out" }, event)}
                onPointerMove={(event) =>
                  dragTarget() && positionFromPointer(event.clientX, dragTarget())
                }
                onPointerUp={finishDrag}
              />
            </Show>
            <For each={workspace.present().segments}>
              {(segment, index) => (
                <span
                  class={`timeline-segment ${workspace.activeSegmentIndex() === index() ? "is-active" : ""}`}
                  role="button"
                  aria-label={`Select cut ${index() + 1}`}
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    workspace.setActiveSegmentIndex(index());
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ")
                      workspace.setActiveSegmentIndex(index());
                  }}
                  onPointerDown={(event) => {
                    workspace.setActiveSegmentIndex(index());
                    beginDrag(
                      {
                        kind: "segment-body",
                        index: index(),
                        offsetMs: pointerTime(event.clientX) - segment.startMs,
                      },
                      event,
                    );
                  }}
                  style={{
                    left: `${(segment.startMs / workspace.duration()) * 100}%`,
                    width: `${((segment.endMs - segment.startMs) / workspace.duration()) * 100}%`,
                  }}
                >
                  <Show when={workspace.activeSegmentIndex() === index()}>
                    <span
                      class="cut-handle cut-handle-start"
                      aria-label={`Resize cut ${index() + 1} start`}
                      onPointerDown={(event) =>
                        beginDrag({ kind: "segment-start", index: index() }, event)
                      }
                    />
                    <span
                      class="cut-handle cut-handle-end"
                      aria-label={`Resize cut ${index() + 1} end`}
                      onPointerDown={(event) =>
                        beginDrag({ kind: "segment-end", index: index() }, event)
                      }
                    />
                  </Show>
                </span>
              )}
            </For>
            <span
              class="timeline-overlay timeline-playhead"
              style={{ left: `${(workspace.playheadMs() / workspace.duration()) * 100}%` }}
            />
          </div>
          <Show when={hoverMs() !== undefined}>
            <output
              class="timeline-timecode"
              style={{ left: `${(hoverMs()! / workspace.duration()) * 100}%` }}
            >
              {formatTime(hoverMs()!, workspace.duration())}
            </output>
          </Show>
        </div>
      </div>
    </div>
  );
}
