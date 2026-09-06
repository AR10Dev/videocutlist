import { For, Show } from "solid-js";
import { ArrowDown, ArrowUp, Play, Repeat2, Scissors, Trash2 } from "lucide-solid";
import { formatTime, segmentIncluded } from "../preview/model";
import { useWorkspace } from "../app/WorkspaceContext";

export function CutsView() {
  const workspace = useWorkspace();
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
            <p>No cuts selected.</p>
            <p>Set In and Out on the timeline, then choose Add cut.</p>
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
                aria-label={`Cut ${index() + 1}${segmentIncluded(segment) ? " included" : " excluded"}`}
                data-segment-id={segment.id}
              >
                <button
                  class="cut-select"
                  type="button"
                  aria-label={`Select cut ${index() + 1}`}
                  aria-pressed={workspace.activeSegmentIndex() === index()}
                  onClick={() => workspace.setActiveSegmentIndex(index())}
                >
                  <strong>{String(index() + 1).padStart(2, "0")}</strong>
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
                    placeholder="Optional label"
                    onChange={(event) =>
                      workspace.updateSegmentLabel(index(), event.currentTarget.value)
                    }
                  />
                </label>
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
                          workspace.setActiveSegmentIndex(index());
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
                          workspace.playActiveSegment(true);
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
