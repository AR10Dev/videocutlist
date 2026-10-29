import { onCleanup } from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import { useWorkspace } from "../../app/WorkspaceContext";
import { useServerAtom } from "../../app/server";
import { createProjectToolsSession } from "./import";
import { ProjectBrowser } from "./ProjectBrowser";

import { useConfirmation, discardChanges } from "../../components/ConfirmDialog";

export function ProjectDialog(props: {
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const workspace = useWorkspace();
  const confirm = useConfirmation();
  const tools = createProjectToolsSession(workspace, () => confirm(discardChanges));
  const operationState = useServerAtom(() => tools.result);
  const pending = () => operationState.waiting();
  onCleanup(() => {
    tools.close();
  });

  const importCutList = (event: Event & { currentTarget: HTMLInputElement }) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    tools.import(file);
  };

  return (
    <Dialog defaultOpen onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <div class="modal modal-open">
          <Dialog.Overlay class="modal-backdrop" />
          <Dialog.Content
            aria-modal="true"
            class="modal-box max-h-[min(90dvh,760px)] max-w-2xl"
            onCloseAutoFocus={props.onCloseAutoFocus}
          >
            <div class="flex items-start justify-between gap-4">
              <div>
                <span class="section-kicker">Workspace</span>
                <Dialog.Title id="project-tools-heading" class="text-lg font-bold">
                  Project tools
                </Dialog.Title>
              </div>
              <Dialog.CloseButton class="btn btn-ghost btn-sm" aria-label="Close project tools">
                Close
              </Dialog.CloseButton>
            </div>
            <section aria-labelledby="current-project-heading" class="mt-4 grid gap-2">
              <h3 id="current-project-heading">Current project</h3>
              <label for="project-name">Project name</label>
              <input
                id="project-name"
                class="input input-sm w-full min-w-0"
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
                Import a project JSON, CSV cut list, or chapters text. Legacy project JSON requires
                its media to be selected.
              </p>
              <label for="import-cut-list">Import cut list</label>
              <input
                id="import-cut-list"
                class="file-input file-input-sm mt-1 w-full min-w-0"
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
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
