import { For, Show } from "solid-js";
import {
  ArrowDown,
  ArrowUp,
  CornerDownLeft,
  CornerDownRight,
  Copy,
  MoreVertical,
  Scissors,
  Trash2,
} from "lucide-solid";
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
  const duplicate = (index: number) => {
    const segments = workspace.present().segments;
    const segment = segments[index];
    if (!segment) return;
    const next = [...segments.slice(0, index + 1), { ...segment }, ...segments.slice(index + 1)];
    workspace.updateTimeline({ segments: next });
    workspace.setActiveSegmentIndex(index + 1);
  };
  return (
    <section
      class="cuts-panel flex min-h-0 flex-col gap-3 p-3"
      role="region"
      aria-labelledby="cuts-tab"
    >
      <header class="flex items-baseline justify-between gap-2 border-b border-base-300 pb-2">
        <h2 class="text-base font-semibold">Cuts</h2>
        <p class="badge badge-ghost badge-sm" role="status">
          {workspace.present().segments.length}
        </p>
      </header>
      <Show
        when={workspace.present().segments.length}
        fallback={
          <p class="alert alert-info text-sm">
            Set In and Out on the timeline, then choose Add cut.
          </p>
        }
      >
        <ol class="list-none space-y-1 p-0" aria-label="Selected segments">
          <For each={workspace.present().segments}>
            {(segment, index) => (
              <li class="flex items-stretch gap-1" aria-label={`Cut ${index() + 1}`}>
                <button
                  class={`btn btn-ghost h-auto min-h-14 flex-1 justify-start px-2 py-1 text-left ${workspace.activeSegmentIndex() === index() ? "border border-primary bg-primary/15" : "border border-transparent"}`}
                  type="button"
                  aria-label={`Select cut ${index() + 1}`}
                  aria-pressed={workspace.activeSegmentIndex() === index()}
                  onClick={() => select(index())}
                >
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <strong class="truncate text-sm">
                      {String(index() + 1).padStart(2, "0")} · {segment.label || "Unlabelled"}
                    </strong>
                    <span class="text-xs text-base-content/70">
                      {formatTime(segment.startMs, workspace.duration())} –{" "}
                      {formatTime(segment.endMs, workspace.duration())}
                    </span>
                    <small class="text-xs text-base-content/60">
                      {formatTime(segment.endMs - segment.startMs, workspace.duration())}
                    </small>
                  </span>
                </button>
                <details class="dropdown dropdown-end">
                  <summary
                    class="btn btn-ghost btn-square btn-sm self-center"
                    aria-label={`Actions for cut ${index() + 1}`}
                  >
                    <MoreVertical size={16} aria-hidden="true" />
                  </summary>
                  <ul
                    class="dropdown-content menu menu-sm z-10 w-48 rounded-box border border-base-300 bg-base-100 p-2 shadow"
                    aria-label={`Cut ${index() + 1} actions`}
                  >
                    <li>
                      <button
                        type="button"
                        onClick={() => {
                          document.getElementById(`cut-label-${index()}`)?.focus();
                        }}
                      >
                        <span aria-hidden="true">✎</span>Rename
                      </button>
                    </li>
                    <li>
                      <button type="button" onClick={() => duplicate(index())}>
                        <Copy size={14} aria-hidden="true" />
                        Duplicate
                      </button>
                    </li>
                    <li>
                      <button type="button" onClick={() => workspace.splitActiveSegment()}>
                        <Scissors size={14} aria-hidden="true" />
                        Split at playhead
                      </button>
                    </li>
                    <li>
                      <button type="button" onClick={() => select(index(), "start")}>
                        <CornerDownLeft size={14} aria-hidden="true" />
                        Jump to start
                      </button>
                    </li>
                    <li>
                      <button type="button" onClick={() => select(index(), "end")}>
                        <CornerDownRight size={14} aria-hidden="true" />
                        Jump to end
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        disabled={index() === 0}
                        onClick={() => workspace.moveSegment(index(), -1)}
                      >
                        <ArrowUp size={14} aria-hidden="true" />
                        Move up
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        disabled={index() === workspace.present().segments.length - 1}
                        onClick={() => workspace.moveSegment(index(), 1)}
                      >
                        <ArrowDown size={14} aria-hidden="true" />
                        Move down
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        class="text-error"
                        onClick={() => workspace.removeSegment(index())}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                        Delete
                      </button>
                    </li>
                  </ul>
                </details>
                <label class="sr-only">
                  Rename cut {index() + 1}
                  <input
                    id={`cut-label-${index()}`}
                    class="input input-xs"
                    aria-label={`Label cut ${index() + 1}`}
                    value={segment.label ?? ""}
                    onChange={(event) =>
                      workspace.updateSegmentLabel(index(), event.currentTarget.value)
                    }
                  />
                </label>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </section>
  );
}
