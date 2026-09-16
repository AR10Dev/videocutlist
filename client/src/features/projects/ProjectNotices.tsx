import { Show } from "solid-js";
import { useWorkspace } from "../app/WorkspaceContext";

export function RecoveryNotice() {
  const workspace = useWorkspace();
  return (
    <Show when={!workspace.dirty() && workspace.projects.recovery()}>
      {(snapshot) => (
        <div class="alert alert-info" role="status">
          <span>
            Local recovery is available from {new Date(snapshot().savedAt).toLocaleString()}.
          </span>
          <button
            class="btn btn-sm"
            type="button"
            onClick={() => void workspace.projects.recoverProject()}
          >
            Recover local edits
          </button>
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            onClick={workspace.projects.dismissRecovery}
          >
            Dismiss
          </button>
        </div>
      )}
    </Show>
  );
}

export function ProjectConflictNotice() {
  const workspace = useWorkspace();
  return (
    <Show when={workspace.projects.saveConflict()}>
      <div class="alert alert-warning" role="alert">
        <span>Another client saved this project. Choose which version to keep.</span>
        <div class="flex flex-wrap gap-2">
          <button
            class="btn btn-sm"
            type="button"
            onClick={() => void workspace.projects.reloadRemoteProject()}
          >
            Reload remote project
          </button>
          <button
            class="btn btn-sm btn-primary"
            type="button"
            onClick={() => void workspace.projects.saveAsNewProject()}
          >
            Save local work as new project
          </button>
        </div>
      </div>
    </Show>
  );
}
