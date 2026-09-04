import { For, Show } from "solid-js";
import { ArrowDown, ArrowUp, Copy, LocateFixed, Trash2 } from "lucide-solid";
import { formatTime } from "../preview/model";
import { useWorkspace } from "../app/WorkspaceContext";

export function CutsView() {
  const workspace = useWorkspace();
  const select = (index: number, seek = false) => {
    workspace.setActiveSegmentIndex(index);
    const segment = workspace.present().segments[index];
    if (seek && segment) workspace.updateTimeline({ playheadMs: segment.startMs });
  };
  const duplicate = (index: number) => {
    const segments = workspace.present().segments;
    const segment = segments[index];
    if (!segment) return;
    workspace.updateTimeline({ segments: [...segments.slice(0, index + 1), { ...segment, label: segment.label ? `${segment.label} copy` : undefined }, ...segments.slice(index + 1)] });
    workspace.setActiveSegmentIndex(index + 1);
  };
  return <section class="cuts-panel" role="region" aria-labelledby="cuts-tab">
    <header class="task-heading"><h2>Cuts</h2><p role="status">{workspace.present().segments.length} selected · {formatTime(workspace.present().segments.reduce((sum, s) => sum + s.endMs - s.startMs, 0), workspace.duration())} total</p></header>
    <Show when={workspace.present().segments.length} fallback={<p class="empty-state">No cuts yet. Set In and Out on the timeline, then choose Add cut.</p>}>
      <ol class="cuts-list" aria-label="Selected cuts">
        <For each={workspace.present().segments}>{(segment, index) => <li class={`cut-row ${workspace.activeSegmentIndex() === index() ? "is-active" : ""}`}>
          <button class="cut-select" type="button" aria-label={`Select cut ${index() + 1}`} aria-pressed={workspace.activeSegmentIndex() === index()} onClick={() => select(index())}>
            <strong>{index() + 1}. {segment.label || "Unlabelled"}</strong>
            <span>{formatTime(segment.startMs, workspace.duration())} – {formatTime(segment.endMs, workspace.duration())}</span>
            <small>{formatTime(segment.endMs - segment.startMs, workspace.duration())}</small>
          </button>
          <div class="cut-actions" aria-label={`Actions for cut ${index() + 1}`}>
            <button class="btn btn-sm btn-square" aria-label={`Jump to cut ${index() + 1} start`} onClick={() => select(index(), true)}><LocateFixed size={14} /></button>
            <button class="btn btn-sm btn-square" aria-label={`Move cut ${index() + 1} up`} disabled={index() === 0} onClick={() => workspace.moveSegment(index(), -1)}><ArrowUp size={14} /></button>
            <button class="btn btn-sm btn-square" aria-label={`Move cut ${index() + 1} down`} disabled={index() === workspace.present().segments.length - 1} onClick={() => workspace.moveSegment(index(), 1)}><ArrowDown size={14} /></button>
            <button class="btn btn-sm btn-square" aria-label={`Duplicate cut ${index() + 1}`} onClick={() => duplicate(index())}><Copy size={14} /></button>
            <button class="btn btn-sm btn-square btn-error" aria-label={`Remove cut ${index() + 1}`} onClick={() => workspace.removeSegment(index())}><Trash2 size={14} /></button>
          </div>
        </li>}</For>
      </ol>
    </Show>
  </section>;
}
