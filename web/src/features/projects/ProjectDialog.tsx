import { onCleanup, onMount } from "solid-js";
import { useWorkspace } from "../app/WorkspaceContext";
import { useServerAtom } from "../app/server";
import { createProjectToolsSession } from "./import";
import { ProjectBrowser } from "./ProjectBrowser";

export function ProjectDialog(props: { onClose: () => void }) {
  const workspace = useWorkspace();
  const tools = createProjectToolsSession(workspace, () =>
    window.confirm("Discard unsaved changes?"),
  );
  const operationState = useServerAtom(() => tools.result);
  let dialog: HTMLDialogElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  const pending = () => operationState.waiting();
  onCleanup(() => {
    tools.close();
  });

  onMount(() => {
    dialog?.showModal();
    closeButton?.focus();
  });

  const importCutList = (event: Event & { currentTarget: HTMLInputElement }) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    tools.import(file);
  };

  return (
    <dialog
      ref={(element) => (dialog = element)}
      class="modal project-tools-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-tools-heading"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <div class="modal-box max-w-2xl">
        <div class="flex items-start justify-between gap-4">
          <div>
            <span class="section-kicker">Workspace</span>
            <h2 id="project-tools-heading" class="text-lg font-bold">
              Project tools
            </h2>
          </div>
          <button
            ref={(element) => (closeButton = element)}
            class="btn btn-ghost btn-sm"
            type="button"
            aria-label="Close project tools"
            onClick={props.onClose}
          >
            Close
          </button>
        </div>
        <section aria-labelledby="current-project-heading" class="mt-4 grid gap-2">
          <h3 id="current-project-heading">Current project</h3>
          <label for="project-name">Project name</label>
          <input
            id="project-name"
            class="input input-bordered input-sm w-full"
            value={workspace.projectName()}
            onInput={(event) => {
              workspace.editProjectName(event.currentTarget.value);
            }}
          />
          <p class="text-sm text-base-content/70">
            Project ID: {workspace.projectId()} · Revision {workspace.revision()}
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              class="btn btn-primary btn-sm"
              type="button"
              disabled={workspace.projects.saveState() === "saving"}
              onClick={() => void workspace.projects.saveProject()}
            >
              {workspace.projects.saveState() === "saving" ? "Saving…" : "Save project"}
            </button>
          </div>
        </section>
        <details class="mt-4">
          <summary>Interchange</summary>
          <p class="text-sm text-base-content/70">
            Import a project JSON, CSV cut list, or chapters text. Legacy project JSON requires its
            media to be selected.
          </p>
          <label for="import-cut-list">Import cut list</label>
          <input
            id="import-cut-list"
            class="file-input file-input-sm file-input-bordered mt-1 w-full"
            type="file"
            accept="application/json,.json,text/csv,.csv,text/plain,.txt,.chapters"
            disabled={pending()}
            onChange={importCutList}
          />
          <div class="mt-2 flex flex-wrap gap-2">
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              disabled={pending() || !workspace.activeItemId()}
              onClick={() => tools.export("csv")}
            >
              Download CSV cut list
            </button>
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              disabled={pending() || !workspace.activeItemId()}
              onClick={() => tools.export("chapters")}
            >
              Download chapters
            </button>
          </div>
        </details>
        <ProjectBrowser />
        <p role="status" aria-live="polite">
          {workspace.status()}
        </p>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button type="button" aria-label="Close project tools backdrop" onClick={props.onClose} />
      </form>
    </dialog>
  );
}
