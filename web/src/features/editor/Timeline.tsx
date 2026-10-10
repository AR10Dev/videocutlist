import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { animate } from "motion";
import { viewportScale } from "../preview/assets";
import { formatTime, segmentIncluded } from "../preview/model";
import {
  fitSelectionZoom,
  timelineNudgeMs,
  timelineTimeFromPointer,
  visibleTimelineWindow,
} from "./timeline";
import { useWorkspace } from "../app/WorkspaceContext";
import { TimelineCanvas } from "./TimelineCanvas";

type DragTarget =
  | { kind: "playhead" | "draft-in" | "draft-out" }
  | { kind: "segment-start" | "segment-end"; index: number }
  | { kind: "segment-body"; index: number; offsetMs: number };

const segmentTone = (segment: { id?: string }) => {
  let hash = 0;
  for (const character of segment.id ?? "segment") hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 5;
};

export function Timeline() {
  const workspace = useWorkspace();
  const [dragTarget, setDragTarget] = createSignal<DragTarget>();
  const [hoverMs, setHoverMs] = createSignal<number>();
  const [visibleWindow, setVisibleWindow] = createSignal({
    startMs: 0,
    endMs: workspace.editor.duration(),
  });
  let scroller: HTMLDivElement | undefined;
  let timeline: HTMLDivElement | undefined;

  const pointerTime = (clientX: number) => {
    if (!timeline) return 0;
    const bounds = timeline.getBoundingClientRect();
    return timelineTimeFromPointer(clientX, bounds.left, bounds.width, workspace.editor.duration());
  };
  const updateWindow = () => {
    if (!scroller || !timeline) return;
    const next = {
      ...visibleTimelineWindow(
        scroller.scrollLeft,
        scroller.clientWidth,
        timeline.getBoundingClientRect().width,
        workspace.editor.duration(),
      ),
      widthPx: scroller.clientWidth,
    };
    setVisibleWindow(next);
    const current = workspace.visibleTimelineRange();
    if (
      current.startMs !== next.startMs ||
      current.endMs !== next.endMs ||
      current.widthPx !== next.widthPx
    )
      workspace.setVisibleTimelineRange(next);
  };
  const positionFromPointer = (clientX: number, target: DragTarget = { kind: "playhead" }) => {
    const value = pointerTime(clientX);
    setHoverMs(value);
    if (target.kind === "playhead") workspace.editor.updateTimeline({ playheadMs: value });
    else if (target.kind === "draft-in")
      workspace.editor.previewMarker(
        "inMs",
        Math.min(value, workspace.editor.present().outMs ?? workspace.editor.duration()),
      );
    else if (target.kind === "draft-out")
      workspace.editor.previewMarker(
        "outMs",
        Math.max(value, workspace.editor.present().inMs ?? 0),
      );
    else if (target.kind === "segment-start")
      workspace.editor.previewSegment(target.index, { boundary: "start", valueMs: value });
    else if (target.kind === "segment-end")
      workspace.editor.previewSegment(target.index, { boundary: "end", valueMs: value });
    else if (target.kind === "segment-body")
      workspace.editor.previewSegment(target.index, { startMs: value - target.offsetMs });
  };
  const beginDrag = (target: DragTarget, event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    workspace.editor.beginDrag();
    setDragTarget(target);
    if (target.kind !== "playhead") workspace.preview.pausePlayback();
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
    workspace.editor.beginDrag();
    setDragTarget(target);
    if (target.kind !== "playhead") workspace.preview.pausePlayback();
  };
  const finishDrag = () => {
    const target = dragTarget();
    setDragTarget();
    if (target)
      workspace.editor.commitDrag(
        target.kind === "playhead" || target.kind === "draft-in" || target.kind === "draft-out"
          ? target.kind
          : "segment",
      );
    if (timeline) animate(timeline, { scaleY: 1 }, { duration: 0.1 });
  };
  const cancelDrag = () => {
    if (!dragTarget()) return;
    setDragTarget();
    workspace.editor.cancelDrag();
    if (timeline) animate(timeline, { scaleY: 1 }, { duration: 0.1 });
  };
  const fitSelection = () => {
    const segment = workspace.editor.activeSegment();
    if (!segment || workspace.editor.duration() <= 0) return;
    workspace.editor.updateTimeline({
      zoom: fitSelectionZoom(workspace.editor.duration(), segment.startMs, segment.endMs),
    });
    requestAnimationFrame(() => {
      if (scroller && timeline) {
        const center =
          ((segment.startMs + segment.endMs) / 2 / workspace.editor.duration()) *
          timeline.clientWidth;
        scroller.scrollLeft = Math.max(0, center - scroller.clientWidth / 2);
      }
      updateWindow();
    });
  };
  const setZoom = (zoom: number) => {
    const anchorMs = hoverMs() ?? workspace.editor.playheadMs();
    workspace.editor.updateTimeline({ zoom: Math.max(1, Math.min(16, zoom)) });
    requestAnimationFrame(() => {
      if (scroller && timeline)
        scroller.scrollLeft =
          (anchorMs / workspace.editor.duration()) * timeline.clientWidth -
          scroller.clientWidth / 2;
      updateWindow();
    });
  };
  const onZoom = (event: Event) => setZoom(zoom() * (event as CustomEvent<number>).detail);
  const onFit = () => {
    workspace.editor.updateTimeline({ zoom: 1 });
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollLeft = 0;
      updateWindow();
    });
  };
  globalThis.addEventListener("timeline-zoom", onZoom);
  globalThis.addEventListener("timeline-fit", onFit);
  globalThis.addEventListener("timeline-fit-selection", fitSelection);
  const resizeObserver = new ResizeObserver(updateWindow);
  onCleanup(() => {
    resizeObserver.disconnect();
    globalThis.removeEventListener("timeline-zoom", onZoom);
    globalThis.removeEventListener("timeline-fit", onFit);
    globalThis.removeEventListener("timeline-fit-selection", fitSelection);
  });
  createEffect(() => {
    setVisibleWindow({
      startMs: 0,
      endMs: workspace.editor.duration() / workspace.editor.present().zoom,
    });
    requestAnimationFrame(updateWindow);
  });
  const handlePointerMove = (event: PointerEvent | MouseEvent) => {
    const target = dragTarget();
    if (target) positionFromPointer(event.clientX, target);
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    const isEditable =
      target instanceof HTMLElement &&
      target.closest("input, textarea, select, [contenteditable='true']");
    if (event.key !== "Escape" || !dragTarget() || isEditable) return;
    event.preventDefault();
    event.stopPropagation();
    cancelDrag();
  };
  globalThis.addEventListener("pointermove", handlePointerMove);
  globalThis.addEventListener("pointerup", finishDrag);
  globalThis.addEventListener("mousemove", handlePointerMove);
  globalThis.addEventListener("mouseup", finishDrag);
  globalThis.addEventListener("keydown", handleKeyDown, true);
  onCleanup(() => {
    cancelDrag();
    globalThis.removeEventListener("pointermove", handlePointerMove);
    globalThis.removeEventListener("pointerup", finishDrag);
    globalThis.removeEventListener("mousemove", handlePointerMove);
    globalThis.removeEventListener("mouseup", finishDrag);
    globalThis.removeEventListener("keydown", handleKeyDown, true);
  });

  const zoom = () => workspace.editor.present().zoom;
  return (
    <div class="timeline-wrap">
      <div
        ref={(element) => {
          scroller = element;
          resizeObserver?.observe(element);
        }}
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
          onPointerCancel={cancelDrag}
        >
          <input
            class="timeline-playhead-input"
            aria-label="Timeline playhead"
            aria-describedby="timeline-description"
            aria-valuetext={`${formatTime(workspace.editor.playheadMs(), workspace.editor.duration())} of ${formatTime(workspace.editor.duration(), workspace.editor.duration())}`}
            type="range"
            min="0"
            max={workspace.editor.duration()}
            step="1"
            value={workspace.editor.playheadMs()}
            onInput={(event) =>
              workspace.editor.updateTimeline({ playheadMs: Number(event.currentTarget.value) })
            }
          />
          <div class="timeline-lane timeline-ruler" role="img" aria-label="Timeline ruler">
            <span>{formatTime(visibleWindow().startMs, workspace.editor.duration())}</span>
            <span>
              {formatTime(
                (visibleWindow().startMs + visibleWindow().endMs) / 2,
                workspace.editor.duration(),
              )}
            </span>
            <span>{formatTime(visibleWindow().endMs, workspace.editor.duration())}</span>
          </div>
          <div class="timeline-lane timeline-thumbnails" role="img" aria-label="Thumbnail lane">
            <TimelineCanvas
              thumbnailURL={workspace.preview.thumbnailURL()}
              waveform={[]}
              lane="thumbnail"
              durationMs={workspace.editor.duration()}
              assetRange={workspace.preview.assetRange()}
            />
          </div>
          <Show when={workspace.preview.waveformVisible()}>
            <div class="timeline-lane timeline-waveform" role="img" aria-label="Waveform lane">
              <TimelineCanvas
                waveform={workspace.preview.waveform()}
                lane="waveform"
                durationMs={workspace.editor.duration()}
                assetRange={workspace.preview.assetRange()}
              />
            </div>
          </Show>
          <div class="timeline-overlays">
            <Show
              when={
                !workspace.editor.editingActive() && workspace.editor.present().inMs !== undefined
              }
            >
              <span
                class="timeline-overlay timeline-in"
                aria-label="In marker"
                style={{
                  left: `${(workspace.editor.present().inMs! / workspace.editor.duration()) * 100}%`,
                }}
                onPointerDown={(event) => beginDrag({ kind: "draft-in" }, event)}
                onMouseDown={(event) => beginMouseDrag({ kind: "draft-in" }, event)}
                onPointerMove={(event) =>
                  dragTarget() && positionFromPointer(event.clientX, dragTarget())
                }
                onPointerUp={finishDrag}
              />
            </Show>
            <Show
              when={
                !workspace.editor.editingActive() && workspace.editor.present().outMs !== undefined
              }
            >
              <span
                class="timeline-overlay timeline-out"
                aria-label="Out marker"
                style={{
                  left: `${(workspace.editor.present().outMs! / workspace.editor.duration()) * 100}%`,
                }}
                onPointerDown={(event) => beginDrag({ kind: "draft-out" }, event)}
                onMouseDown={(event) => beginMouseDrag({ kind: "draft-out" }, event)}
                onPointerMove={(event) =>
                  dragTarget() && positionFromPointer(event.clientX, dragTarget())
                }
                onPointerUp={finishDrag}
              />
            </Show>
            <For each={workspace.editor.present().segments}>
              {(segment, index) => (
                <span
                  class={`timeline-segment segment-tone-${segmentTone(segment)} ${workspace.editor.activeSegmentIndex() === index() ? "is-active" : ""} ${segmentIncluded(segment) ? "is-included" : "is-excluded"}`}
                  role="button"
                  aria-pressed={workspace.editor.activeSegmentIndex() === index()}
                  aria-label={`${segment.label || `Segment ${String(index() + 1).padStart(3, "0")}`} · ${segmentIncluded(segment) ? "included" : "excluded"} · ${workspace.editor.activeSegmentIndex() === index() ? "selected" : "not selected"}`}
                  aria-keyshortcuts="ArrowLeft ArrowRight"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    workspace.editor.setActiveSegmentIndex(index());
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      workspace.editor.setActiveSegmentIndex(index());
                    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                      event.preventDefault();
                      event.stopPropagation();
                      workspace.editor.setActiveSegmentIndex(index());
                      workspace.editor.updateSegment(index(), {
                        startMs:
                          segment.startMs + (event.key === "ArrowLeft" ? -1 : 1) * timelineNudgeMs,
                      });
                    }
                  }}
                  onPointerDown={(event) => {
                    workspace.editor.setActiveSegmentIndex(index());
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
                    left: `${(segment.startMs / workspace.editor.duration()) * 100}%`,
                    width: `${((segment.endMs - segment.startMs) / workspace.editor.duration()) * 100}%`,
                  }}
                >
                  <span class="timeline-segment-label">
                    {segment.label || `Segment ${String(index() + 1).padStart(3, "0")}`}
                  </span>
                  <Show when={workspace.editor.activeSegmentIndex() === index()}>
                    <span
                      class="cut-handle cut-handle-start"
                      role="slider"
                      tabIndex={0}
                      aria-label={`Resize cut ${index() + 1} start`}
                      aria-valuemin="0"
                      aria-valuemax={segment.endMs - 1}
                      aria-valuenow={segment.startMs}
                      aria-valuetext={formatTime(segment.startMs, workspace.editor.duration())}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                        event.preventDefault();
                        event.stopPropagation();
                        workspace.editor.updateSegment(index(), {
                          boundary: "start",
                          valueMs:
                            segment.startMs +
                            (event.key === "ArrowLeft" ? -1 : 1) * timelineNudgeMs,
                        });
                      }}
                      onPointerDown={(event) =>
                        beginDrag({ kind: "segment-start", index: index() }, event)
                      }
                    />
                    <span
                      class="cut-handle cut-handle-end"
                      role="slider"
                      tabIndex={0}
                      aria-label={`Resize cut ${index() + 1} end`}
                      aria-valuemin={segment.startMs + 1}
                      aria-valuemax={workspace.editor.duration()}
                      aria-valuenow={segment.endMs}
                      aria-valuetext={formatTime(segment.endMs, workspace.editor.duration())}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                        event.preventDefault();
                        event.stopPropagation();
                        workspace.editor.updateSegment(index(), {
                          boundary: "end",
                          valueMs:
                            segment.endMs + (event.key === "ArrowLeft" ? -1 : 1) * timelineNudgeMs,
                        });
                      }}
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
              style={{
                left: `${(workspace.editor.playheadMs() / workspace.editor.duration()) * 100}%`,
              }}
            />
          </div>
          <Show when={hoverMs() !== undefined}>
            <output
              class="timeline-timecode"
              style={{ left: `${(hoverMs()! / workspace.editor.duration()) * 100}%` }}
            >
              {formatTime(hoverMs()!, workspace.editor.duration())}
            </output>
          </Show>
        </div>
      </div>
    </div>
  );
}
