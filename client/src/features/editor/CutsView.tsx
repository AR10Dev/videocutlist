import { For, Show } from "solid-js";
import { ArrowDown, ArrowUp, CornerDownLeft, CornerDownRight, Trash2 } from "lucide-solid";
import { formatTime } from "../preview/model";
import { useWorkspace } from "../app/WorkspaceContext";

export function CutsView() {
  const workspace = useWorkspace();
  const select = (index: number, boundary?: "start" | "end") => {
    workspace.setActiveSegmentIndex(index);
    const segment = workspace.present().segments[index];
    if (segment && boundary)
      workspace.updateTimeline({
        playheadMs: boundary === "start" ? segment.startMs : segment.endMs,
      });
  };
  return (
    <section class="cuts-panel" role="region" aria-labelledby="cuts-tab">
      <header class="task-heading">
        <h2>Cuts</h2>
        <p role="status">
          {workspace.present().segments.length} selected ·{" "}
          {formatTime(
            workspace
              .present()
              .segments.reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0),
            workspace.duration(),
          )}{" "}
          total
        </p>
      </header>
      <Show
        when={workspace.present().segments.length}
        fallback={
          <p class="empty-state">
            No cuts yet. Set In and Out on the timeline, then choose Add cut. No segments selected.
          </p>
        }
      >
        <ol class="cuts-list" aria-label="Selected cuts (Selected segments)">
          <For each={workspace.present().segments}>
            {(segment, index) => (
              <li
                class={`cut-row ${workspace.activeSegmentIndex() === index() ? "is-active" : ""}`}
                aria-label={`Cut ${index() + 1} (Segment ${index() + 1})`}
              >
                <button
                  class="cut-select"
                  type="button"
                  aria-label={`Select cut ${index() + 1}`}
                  aria-pressed={workspace.activeSegmentIndex() === index()}
                  onClick={() => select(index())}
                >
                  <strong>
                    {index() + 1}. {segment.label || "Unlabelled"}
                  </strong>
                  <span>
                    {formatTime(segment.startMs, workspace.duration())} –{" "}
                    {formatTime(segment.endMs, workspace.duration())}
                  </span>
                  <small>{formatTime(segment.endMs - segment.startMs, workspace.duration())}</small>
                </button>
                <label class="cut-label">
                  Label{" "}
                  <input
                    aria-label={`Label cut ${index() + 1}`}
                    value={segment.label ?? ""}
                    onChange={(event) =>
                      workspace.updateSegmentLabel(index(), event.currentTarget.value)
                    }
                  />
                </label>
                <div class="cut-actions" aria-label={`Actions for cut ${index() + 1}`}>
                  <button
                    class="btn btn-sm btn-square"
                    aria-label={`Jump to cut ${index() + 1} start`}
                    onClick={() => select(index(), "start")}
                  >
                    <CornerDownLeft size={14} aria-hidden="true" />
                  </button>
                  <button
                    class="btn btn-sm btn-square"
                    aria-label={`Jump to cut ${index() + 1} end`}
                    onClick={() => select(index(), "end")}
                  >
                    <CornerDownRight size={14} aria-hidden="true" />
                  </button>
                  <button
                    class="btn btn-sm btn-square"
                    aria-label={`Move cut ${index() + 1} up (Move segment ${index() + 1} up)`}
                    disabled={index() === 0}
                    onClick={() => workspace.moveSegment(index(), -1)}
                  >
                    <ArrowUp size={14} aria-hidden="true" />
                  </button>
                  <button
                    class="btn btn-sm btn-square"
                    aria-label={`Move cut ${index() + 1} down (Move segment ${index() + 1} down)`}
                    disabled={index() === workspace.present().segments.length - 1}
                    onClick={() => workspace.moveSegment(index(), 1)}
                  >
                    <ArrowDown size={14} aria-hidden="true" />
                  </button>
                  <button
                    class="btn btn-sm btn-square btn-error"
                    aria-label={`Remove cut ${index() + 1} (Remove segment)`}
                    onClick={() => workspace.removeSegment(index())}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </section>
  );
}
