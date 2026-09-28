import { Show } from "solid-js";
import { PanelLeft, PanelRight } from "lucide-solid";
import { Timeline } from "./Timeline";
import { formatTime } from "../preview/model";
import { PreviewPlayer } from "../preview/PreviewPlayer";
import { useWorkspace } from "../app/WorkspaceContext";

export function EditorView(props: {
  onChooseMedia: () => void;
  mediaOpen: boolean;
  tasksOpen: boolean;
  openMediaPanel: () => void;
  openTaskPanel: () => void;
}) {
  const workspace = useWorkspace();
  const mediaPanelAction = () => (props.mediaOpen ? "Hide media library" : "Show media library");
  const tasksPanelAction = () => (props.tasksOpen ? "Hide editing tools" : "Show editing tools");
  return (
    <section class="editor-panel" aria-labelledby="timeline-heading">
      <div class="panel-heading editor-heading">
        <div>
          <h2 id="timeline-heading" tabIndex={-1} class="text-base">
            Timeline
          </h2>
        </div>
        <div class="editor-heading-actions" aria-label="Workspace panels">
          <button
            class="btn btn-ghost btn-sm btn-square"
            type="button"
            title={mediaPanelAction()}
            aria-label={mediaPanelAction()}
            aria-expanded={props.mediaOpen}
            aria-controls="media-panel"
            onClick={props.openMediaPanel}
          >
            <PanelLeft size={16} aria-hidden="true" />
          </button>
          <button
            class="btn btn-ghost btn-sm btn-square"
            type="button"
            title={tasksPanelAction()}
            aria-label={tasksPanelAction()}
            aria-expanded={props.tasksOpen}
            aria-controls="segments-panel"
            onClick={props.openTaskPanel}
          >
            <PanelRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <Show
        when={workspace.selected()}
        fallback={
          <section class="editor-onboarding" aria-labelledby="editor-onboarding-heading">
            <h3 id="editor-onboarding-heading">Choose a video to begin</h3>
            <p>Select a video from the Media library to unlock the editing workspace.</p>
            <button class="btn btn-primary" type="button" onClick={props.onChooseMedia}>
              Choose a video
            </button>
          </section>
        }
      >
        {(item) => (
          <>
            <div class="selected-media-summary" aria-label="Selected media">
              <strong>{item().name}</strong>
              <span>{formatTime(item().durationMs, workspace.duration())}</span>
            </div>
            <Show when={workspace.metadataError()}>
              {(message) => (
                <div class="alert alert-error mb-2" role="alert">
                  <span>{message()}</span>
                  <button
                    class="btn btn-ghost btn-xs"
                    type="button"
                    disabled={workspace.metadataLoading()}
                    onClick={workspace.retryMetadata}
                  >
                    {workspace.metadataLoading() ? "Retrying…" : "Retry metadata"}
                  </button>
                </div>
              )}
            </Show>
            <Show when={!workspace.activeItemId()}>
              <div class="preview-only-notice" role="status">
                <p class="text-sm text-base-content/70">
                  Preview only · Your first valid cut adds this video to the project.
                </p>
                <button
                  class="btn btn-primary btn-sm"
                  type="button"
                  onClick={() => workspace.addMediaToProject()}
                >
                  Add to project
                </button>
              </div>
            </Show>
            <p id="timeline-description" class="sr-only">
              Playhead {formatTime(workspace.playheadMs(), workspace.duration())}. In marker{" "}
              {workspace.editingInMs() === undefined
                ? "unset"
                : formatTime(workspace.editingInMs()!, workspace.duration())}
              . Out marker{" "}
              {workspace.editingOutMs() === undefined
                ? "unset"
                : formatTime(workspace.editingOutMs()!, workspace.duration())}
              .{" "}
              {workspace.present().segments.length
                ? `${workspace.present().segments.length} cuts selected.`
                : "No cuts selected."}
            </p>
            <Show when={workspace.assetStatus()}>
              {(message) => (
                <div class="alert alert-info mb-2" role="status">
                  <span>{message()}</span>
                  <button
                    class="btn btn-ghost btn-xs"
                    type="button"
                    onClick={workspace.retryAssets}
                  >
                    Retry assets
                  </button>
                </div>
              )}
            </Show>
            <PreviewPlayer timeline={<Timeline />} />
            <p class="asset-capability" role="status" aria-label="Keyframe snapping availability">
              Keyframe snapping unavailable; authoritative source timestamps are not exposed.
            </p>
            <Show when={workspace.editorStatus()}>
              <p class="control-help" role="alert">
                {workspace.editorStatus()}
              </p>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
