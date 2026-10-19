import { createMemo, For, Show } from "solid-js";
import { ArrowDown, ArrowUp, Play, Repeat2, Scissors, Trash2 } from "lucide-solid";
import { formatTime, segmentIncluded, type Segment } from "../preview/model";
import { useWorkspace } from "../../app/WorkspaceContext";

export function CutsView() {
  const workspace = useWorkspace();
  const { boundaryDrafts, boundaryErrors, labelDrafts, labelErrors } = workspace.editor;
  const segmentKey = (id: string | undefined, index: number) => id ?? `index-${index}`;
  const segmentById = createMemo(
    () =>
      new Map(
        workspace.editor
          .present()
          .segments.map(
            (segment, index) => [segmentKey(segment.id, index), { segment, index }] as const,
          ),
      ),
  );
  const boundaryValue = (segment: Segment, index: number, boundary: "start" | "end") => {
    const key = segmentKey(segment.id, index);
    return (
      boundaryDrafts()[key]?.[boundary] ??
      formatTime(
        boundary === "start" ? segment.startMs : segment.endMs,
        workspace.editor.duration(),
      )
    );
  };
  const labelValue = (segment: Segment, index: number) =>
    labelDrafts()[segmentKey(segment.id, index)] ?? segment.label ?? "";
  return (
    <section class="cuts-panel" aria-labelledby="cuts-tab">
      <header class="task-heading flex items-baseline justify-between gap-2">
        <h2>Cuts</h2>
        <div class="cut-summary text-sm" role="status">
          {workspace.editor.present().segments.length}{" "}
          {workspace.editor.present().segments.length === 1 ? "cut" : "cuts"} ·{" "}
          <Show
            when={workspace.editor.present().segments.some((segment) => !segmentIncluded(segment))}
          >
            {workspace.editor.present().segments.filter(segmentIncluded).length} included ·{" "}
          </Show>
          {formatTime(
            workspace.editor
              .present()
              .segments.filter(segmentIncluded)
              .reduce((total, segment) => total + segment.endMs - segment.startMs, 0),
            workspace.editor.duration(),
          )}
        </div>
      </header>
      <Show
        when={workspace.editor.present().segments.length}
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
          <For
            each={workspace.editor
              .present()
              .segments.map((segment, index) => segmentKey(segment.id, index))}
          >
            {(id) => {
              const current = () => segmentById().get(id)!;
              const segment = () => current().segment;
              const index = () => current().index;
              return (
                <li
                  class="cut-row"
                  classList={{
                    "is-active": workspace.editor.activeSegmentIndex() === index(),
                    "is-excluded": !segmentIncluded(segment()),
                  }}
                  aria-label={`${segment().label || `Segment ${String(index() + 1).padStart(3, "0")}`}${segmentIncluded(segment()) ? " included" : " excluded"}`}
                  data-segment-id={id}
                >
                  <button
                    class="cut-select"
                    type="button"
                    aria-label={`Select cut ${index() + 1}`}
                    aria-pressed={workspace.editor.activeSegmentIndex() === index()}
                    onClick={() => workspace.editor.setActiveSegmentIndex(index())}
                  >
                    <strong>
                      {segment().label || `Segment ${String(index() + 1).padStart(3, "0")}`}
                    </strong>
                    <span class="text-xs">
                      {formatTime(segment().startMs, workspace.editor.duration())} –{" "}
                      {formatTime(segment().endMs, workspace.editor.duration())}
                    </span>
                    <small>
                      {formatTime(segment().endMs - segment().startMs, workspace.editor.duration())}
                    </small>
                  </button>
                  <label class="cut-inclusion">
                    <input
                      class="checkbox checkbox-sm"
                      type="checkbox"
                      checked={segmentIncluded(segment())}
                      aria-label={`Include cut ${index() + 1} in export`}
                      onChange={(event) =>
                        workspace.editor.updateSegmentIncluded(index(), event.currentTarget.checked)
                      }
                    />
                    Include in export
                  </label>
                  <label class="cut-label">
                    Label
                    <input
                      class="input input-sm validator"
                      classList={{
                        "input-error": Boolean(labelErrors()[id]),
                      }}
                      aria-label={`Label cut ${index() + 1}`}
                      aria-invalid={Boolean(labelErrors()[id])}
                      aria-describedby={labelErrors()[id] ? `label-error-${id}` : undefined}
                      value={labelValue(segment(), index())}
                      placeholder="Custom name"
                      onInput={(event) =>
                        workspace.editor.editLabelDraft(id, event.currentTarget.value)
                      }
                      onBlur={() => workspace.editor.commitLabelDraft(id)}
                    />
                    <Show when={labelErrors()[id]}>
                      {(message) => (
                        <small
                          id={`label-error-${id}`}
                          class="validator-hint control-help"
                          role="alert"
                        >
                          {message()}
                        </small>
                      )}
                    </Show>
                  </label>
                  <div class="cut-boundaries" aria-label={`Bounds for cut ${index() + 1}`}>
                    <label>
                      In
                      <input
                        class="input input-sm"
                        aria-label={`Cut ${index() + 1} In`}
                        aria-invalid={Boolean(boundaryErrors()[id])}
                        value={boundaryValue(segment(), index(), "start")}
                        onInput={(event) =>
                          workspace.editor.setBoundaryDraft(id, "start", event.currentTarget.value)
                        }
                        onBlur={() => workspace.editor.confirmBoundary(id, "start")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") workspace.editor.confirmBoundary(id, "start");
                          if (event.key === "Escape") {
                            workspace.editor.cancelBoundary(id, "start");
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
                        aria-invalid={Boolean(boundaryErrors()[id])}
                        value={boundaryValue(segment(), index(), "end")}
                        onInput={(event) =>
                          workspace.editor.setBoundaryDraft(id, "end", event.currentTarget.value)
                        }
                        onBlur={() => workspace.editor.confirmBoundary(id, "end")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") workspace.editor.confirmBoundary(id, "end");
                          if (event.key === "Escape") {
                            workspace.editor.cancelBoundary(id, "end");
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    </label>
                    <span>
                      Duration{" "}
                      {formatTime(segment().endMs - segment().startMs, workspace.editor.duration())}
                    </span>
                    <Show when={boundaryErrors()[id]}>
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
                          onClick={() => workspace.editor.moveSegment(index(), -1)}
                        >
                          <ArrowUp size={16} />
                        </button>
                        <button
                          class="btn btn-ghost btn-sm btn-square"
                          title="Move down"
                          aria-label={`Move cut ${index() + 1} down`}
                          disabled={index() === workspace.editor.present().segments.length - 1}
                          onClick={() => workspace.editor.moveSegment(index(), 1)}
                        >
                          <ArrowDown size={16} />
                        </button>
                        <button
                          class="btn btn-ghost btn-sm btn-square"
                          title="Split at playhead"
                          aria-label={`Split cut ${index() + 1} at playhead`}
                          disabled={
                            workspace.editor.playheadMs() <= segment().startMs ||
                            workspace.editor.playheadMs() >= segment().endMs
                          }
                          onClick={() => {
                            const playheadMs = workspace.editor.playheadMs();
                            if (workspace.editor.activeSegmentIndex() !== index()) {
                              workspace.editor.setActiveSegmentIndex(index());
                              workspace.editor.updateTimeline({ playheadMs });
                            }
                            workspace.editor.splitActiveSegment();
                          }}
                        >
                          <Scissors size={16} />
                        </button>
                        <button
                          class="btn btn-ghost btn-sm btn-square text-error"
                          title="Remove cut"
                          aria-label={`Remove cut ${index() + 1}`}
                          onClick={() => workspace.editor.removeSegment(index())}
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
                            workspace.editor.setActiveSegmentIndex(index());
                            workspace.preview.playActiveSegment(false);
                          }}
                        >
                          <Play size={14} aria-hidden="true" /> Play
                        </button>
                        <button
                          class="btn btn-ghost btn-xs"
                          aria-label={`Loop cut ${index() + 1}`}
                          aria-keyshortcuts="L"
                          onClick={() => {
                            workspace.editor.setActiveSegmentIndex(index());
                            workspace.preview.toggleLoopSelectedSegment();
                          }}
                        >
                          <Repeat2 size={14} aria-hidden="true" /> Loop
                        </button>
                        <button
                          class="btn btn-ghost btn-xs"
                          onClick={() => {
                            workspace.editor.setActiveSegmentIndex(index());
                            workspace.editor.updateTimeline({ playheadMs: segment().startMs });
                          }}
                        >
                          Jump to start
                        </button>
                        <button
                          class="btn btn-ghost btn-xs"
                          onClick={() => {
                            workspace.editor.setActiveSegmentIndex(index());
                            workspace.editor.updateTimeline({ playheadMs: segment().endMs });
                          }}
                        >
                          Jump to end
                        </button>
                      </div>
                    </div>
                  </details>
                </li>
              );
            }}
          </For>
        </ol>
      </Show>
    </section>
  );
}
