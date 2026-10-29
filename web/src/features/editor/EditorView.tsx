import { Show } from "solid-js";
import { Notice } from "../../components/Notice";
import { PanelLeft, PanelRight } from "lucide-solid";
import { installEditorShortcuts } from "./shortcuts";
import { Timeline } from "./Timeline";
import { formatTime } from "../preview/model";
import { PreviewPlayer } from "../preview/PreviewPlayer";
import { useWorkspace } from "../../app/WorkspaceContext";

export function EditorView(props: {
  onChooseMedia: () => void;
  mediaOpen: boolean;
  tasksOpen: boolean;
  openMediaPanel: () => void;
  openTaskPanel: () => void;
}) {
  const workspace = useWorkspace();
  installEditorShortcuts(workspace.editor);
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
            onClick={() => props.openMediaPanel()}
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
            onClick={() => props.openTaskPanel()}
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
              <span>{formatTime(item().durationMs, workspace.editor.duration())}</span>
            </div>
            <Show when={workspace.metadataError()}>
              {(message) => (
                <Notice variant="error">
                  <span>{message()}</span>
                  <button
                    class="btn btn-ghost btn-xs"
                    type="button"
                    disabled={workspace.metadataLoading()}
                    onClick={workspace.retryMetadata}
                  >
                    {workspace.metadataLoading() ? "Retrying…" : "Retry metadata"}
                  </button>
                </Notice>
              )}
            </Show>
            <p id="timeline-description" class="sr-only">
              Playhead {formatTime(workspace.editor.playheadMs(), workspace.editor.duration())}. In
              marker{" "}
              {workspace.editor.editingInMs() === undefined
                ? "unset"
                : formatTime(workspace.editor.editingInMs()!, workspace.editor.duration())}
              . Out marker{" "}
              {workspace.editor.editingOutMs() === undefined
                ? "unset"
                : formatTime(workspace.editor.editingOutMs()!, workspace.editor.duration())}
              .{" "}
              {workspace.editor.present().segments.length
                ? `${workspace.editor.present().segments.length} cuts selected.`
                : "No cuts selected."}
            </p>
            <Show when={workspace.preview.assetStatus()}>
              {(message) => (
                <Notice variant="info">
                  <span>{message()}</span>
                  <button
                    class="btn btn-ghost btn-xs"
                    type="button"
                    onClick={workspace.preview.retryAssets}
                  >
                    Retry assets
                  </button>
                </Notice>
              )}
            </Show>
            <PreviewPlayer timeline={<Timeline />} />
            <Show when={workspace.editor.editorStatus()}>
              <p class="control-help" role="alert">
                {workspace.editor.editorStatus()}
              </p>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
