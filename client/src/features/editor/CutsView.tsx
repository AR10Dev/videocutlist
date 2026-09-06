import { createSignal, For, Show } from "solid-js";
import { ArrowDown, ArrowUp, Play, Repeat2, Scissors, Trash2 } from "lucide-solid";
import { formatTime, parseTimecode, segmentIncluded, type Segment } from "../preview/model";
import { useWorkspace } from "../app/WorkspaceContext";

export function CutsView() {
  const workspace = useWorkspace();
  const [boundaryDrafts, setBoundaryDrafts] = createSignal<
    Record<string, Partial<Record<"start" | "end", string>>>
  >({});
  const [boundaryErrors, setBoundaryErrors] = createSignal<Record<string, string>>({});
  let canceledBoundaryKey: string | undefined;
  const segmentKey = (id: string | undefined, index: number) => id ?? `index-${index}`;
  const boundaryValue = (segment: Segment, index: number, boundary: "start" | "end") => {
    const key = segmentKey(segment.id, index);
    return (
      boundaryDrafts()[key]?.[boundary] ??
      formatTime(boundary === "start" ? segment.startMs : segment.endMs, workspace.duration())
    );
  };
  const confirmBoundary = (
    index: number,
    segment: Segment,
    boundary: "start" | "end",
    input: HTMLInputElement,
  ) => {
    const key = segmentKey(segment.id, index);
    if (canceledBoundaryKey === key) {
      canceledBoundaryKey = undefined;
      return;
    }
    const value = parseTimecode(input.value);
    const valid = value !== undefined && workspace.updateSegmentBoundary(index, boundary, value);
    if (valid) {
      setBoundaryDrafts((current) => ({
        ...current,
        [key]: { ...current[key], [boundary]: undefined },
      }));
      setBoundaryErrors((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      return;
    }
    const message =
      value === undefined
        ? "Enter a valid timecode within this video."
        : workspace.editorStatus() ||
          "That boundary would overlap another cut or leave In before Out.";
    setBoundaryErrors((current) => ({ ...current, [key]: message }));
  };
  return (
    <section class="cuts-panel" aria-labelledby="cuts-tab">
      <header class="task-heading flex items-baseline justify-between gap-2">
        <h2>Cuts</h2>
        <div class="cut-summary text-sm" role="status">
          <span>{workspace.present().segments.length} selected</span>
          <span>
            {workspace.present().segments.filter(segmentIncluded).length} included ·{" "}
            {formatTime(
              workspace
                .present()
                .segments.filter(segmentIncluded)
                .reduce((total, segment) => total + segment.endMs - segment.startMs, 0),
              workspace.duration(),
            )}{" "}
            requested
          </span>
        </div>
      </header>
      <Show
        when={workspace.present().segments.length}
        fallback={
          <div class="text-sm text-base-content/70">
            <p>No segments yet.</p>
            <p>
              Set In and Out on the timeline; a valid range becomes one selected segment
              automatically.
            </p>
          </div>
        }
      >
        <ol class="cuts-list" aria-label="Selected cuts">
          <For each={workspace.present().segments}>
            {(segment, index) => (
              <li
                class="cut-row"
                classList={{
                  "is-active": workspace.activeSegmentIndex() === index(),
                  "is-excluded": !segmentIncluded(segment),
                }}
                aria-label={`${segment.label || `Segment ${String(index() + 1).padStart(3, "0")}`}${segmentIncluded(segment) ? " included" : " excluded"}`}
                data-segment-id={segment.id}
              >
                <button
                  class="cut-select"
                  type="button"
                  aria-label={`Select cut ${index() + 1}`}
                  aria-pressed={workspace.activeSegmentIndex() === index()}
                  onClick={() => workspace.setActiveSegmentIndex(index())}
                >
                  <strong>
                    {segment.label || `Segment ${String(index() + 1).padStart(3, "0")}`}
                  </strong>
                  <span class="text-xs">
                    {formatTime(segment.startMs, workspace.duration())} –{" "}
                    {formatTime(segment.endMs, workspace.duration())}
                  </span>
                  <small>{formatTime(segment.endMs - segment.startMs, workspace.duration())}</small>
                </button>
                <label class="cut-inclusion">
                  <input
                    class="checkbox checkbox-sm"
                    type="checkbox"
                    checked={segmentIncluded(segment)}
                    aria-label={`Include cut ${index() + 1} in export`}
                    onChange={(event) =>
                      workspace.updateSegmentIncluded(index(), event.currentTarget.checked)
                    }
                  />
                  Include in export
                </label>
                <label class="cut-label">
                  Label
                  <input
                    class="input input-sm"
                    aria-label={`Label cut ${index() + 1}`}
                    value={segment.label ?? ""}
                    placeholder="Custom name"
                    onChange={(event) =>
                      workspace.updateSegmentLabel(index(), event.currentTarget.value)
                    }
                  />
                </label>
                <div class="cut-boundaries" aria-label={`Bounds for cut ${index() + 1}`}>
                  <label>
                    In
                    <input
                      class="input input-sm"
                      aria-label={`Cut ${index() + 1} In`}
                      aria-invalid={Boolean(boundaryErrors()[segmentKey(segment.id, index())])}
                      value={boundaryValue(segment, index(), "start")}
                      onInput={(event) =>
                        setBoundaryDrafts((current) => ({
                          ...current,
                          [segmentKey(segment.id, index())]: {
                            ...current[segmentKey(segment.id, index())],
                            start: event.currentTarget.value,
                          },
                        }))
                      }
                      onBlur={(event) =>
                        confirmBoundary(index(), segment, "start", event.currentTarget)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter")
                          confirmBoundary(index(), segment, "start", event.currentTarget);
                        if (event.key === "Escape") {
                          const key = segmentKey(segment.id, index());
                          canceledBoundaryKey = key;
                          setBoundaryDrafts((current) => ({
                            ...current,
                            [key]: { ...current[key], start: undefined },
                          }));
                          setBoundaryErrors((current) => {
                            const next = { ...current };
                            delete next[key];
                            return next;
                          });
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  </label>
                  <label>
                    Out
                    <input
                      class="input input-sm"
                      aria-label={`Cut ${index() + 1} Out`}
                      aria-invalid={Boolean(boundaryErrors()[segmentKey(segment.id, index())])}
                      value={boundaryValue(segment, index(), "end")}
                      onInput={(event) =>
                        setBoundaryDrafts((current) => ({
                          ...current,
                          [segmentKey(segment.id, index())]: {
                            ...current[segmentKey(segment.id, index())],
                            end: event.currentTarget.value,
                          },
                        }))
                      }
                      onBlur={(event) =>
                        confirmBoundary(index(), segment, "end", event.currentTarget)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter")
                          confirmBoundary(index(), segment, "end", event.currentTarget);
                        if (event.key === "Escape") {
                          const key = segmentKey(segment.id, index());
                          canceledBoundaryKey = key;
                          setBoundaryDrafts((current) => ({
                            ...current,
                            [key]: { ...current[key], end: undefined },
                          }));
                          setBoundaryErrors((current) => {
                            const next = { ...current };
                            delete next[key];
                            return next;
                          });
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  </label>
                  <span>
                    Duration {formatTime(segment.endMs - segment.startMs, workspace.duration())}
                  </span>
                  <Show when={boundaryErrors()[segmentKey(segment.id, index())]}>
                    {(message) => (
                      <small class="control-help" role="alert">
                        {message()}
                      </small>
                    )}
                  </Show>
                </div>
                <details class="cut-menu" open>
                  <summary class="btn btn-ghost btn-sm">Actions</summary>
                  <div class="cut-menu-panel">
                    <div class="cut-actions">
                      <button
                        class="btn btn-ghost btn-sm btn-square"
                        title="Move up"
                        aria-label={`Move cut ${index() + 1} up`}
                        disabled={index() === 0}
                        onClick={() => workspace.moveSegment(index(), -1)}
                      >
                        <ArrowUp size={16} />
                      </button>
                      <button
                        class="btn btn-ghost btn-sm btn-square"
                        title="Move down"
                        aria-label={`Move cut ${index() + 1} down`}
                        disabled={index() === workspace.present().segments.length - 1}
                        onClick={() => workspace.moveSegment(index(), 1)}
                      >
                        <ArrowDown size={16} />
                      </button>
                      <button
                        class="btn btn-ghost btn-sm btn-square"
                        title="Split at playhead"
                        aria-label={`Split cut ${index() + 1} at playhead`}
                        disabled={
                          workspace.playheadMs() <= segment.startMs ||
                          workspace.playheadMs() >= segment.endMs
                        }
                        onClick={() => {
                          const playheadMs = workspace.playheadMs();
                          if (workspace.activeSegmentIndex() !== index()) {
                            workspace.setActiveSegmentIndex(index());
                            workspace.updateTimeline({ playheadMs });
                          }
                          workspace.splitActiveSegment();
                        }}
                      >
                        <Scissors size={16} />
                      </button>
                      <button
                        class="btn btn-ghost btn-sm btn-square text-error"
                        title="Remove cut"
                        aria-label={`Remove cut ${index() + 1}`}
                        onClick={() => workspace.removeSegment(index())}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <div class="cut-actions">
                      <button
                        class="btn btn-ghost btn-xs"
                        aria-label={`Play cut ${index() + 1}`}
                        aria-keyshortcuts="P"
                        onClick={() => {
                          workspace.setActiveSegmentIndex(index());
                          workspace.playActiveSegment(false);
                        }}
                      >
                        <Play size={14} aria-hidden="true" /> Play{" "}
                        <kbd class="kbd kbd-xs" aria-hidden="true">
                          P
                        </kbd>
                      </button>
                      <button
                        class="btn btn-ghost btn-xs"
                        aria-label={`Loop cut ${index() + 1}`}
                        aria-keyshortcuts="L"
                        onClick={() => {
                          workspace.setActiveSegmentIndex(index());
                          workspace.toggleLoopSelectedSegment();
                        }}
                      >
                        <Repeat2 size={14} aria-hidden="true" /> Loop{" "}
                        <kbd class="kbd kbd-xs" aria-hidden="true">
                          L
                        </kbd>
                      </button>
                      <button
                        class="btn btn-ghost btn-xs"
                        onClick={() => {
                          workspace.setActiveSegmentIndex(index());
                          workspace.updateTimeline({ playheadMs: segment.startMs });
                        }}
                      >
                        Jump to start
                      </button>
                      <button
                        class="btn btn-ghost btn-xs"
                        onClick={() => {
                          workspace.setActiveSegmentIndex(index());
                          workspace.updateTimeline({ playheadMs: segment.endMs });
                        }}
                      >
                        Jump to end
                      </button>
                    </div>
                  </div>
                </details>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </section>
  );
}
