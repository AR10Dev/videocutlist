import { onMount } from "solid-js";
import type { components } from "../../generated/api";
import { validInterchangeFileSize } from "../../api";
import { useWorkspace } from "../app/WorkspaceContext";
import { validateSegments, type Segment } from "../preview/model";
import { parseProjectJson } from "./lifecycle";
import { ProjectBrowser } from "./ProjectBrowser";

export function ProjectDialog(props: { onClose: () => void }) {
  const workspace = useWorkspace();
  let dialog: HTMLDialogElement | undefined;
  let closeButton: HTMLButtonElement | undefined;

  onMount(() => {
    dialog?.showModal();
    closeButton?.focus();
  });

  const importCutList = (event: Event & { currentTarget: HTMLInputElement }) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    if (!validInterchangeFileSize(file.size)) {
      workspace.setStatus("Cut list exceeds the 1 MiB limit.");
      return;
    }
    void file
      .text()
      .then((text) => {
        const imported = parseProjectJson(text);
        if (imported.schemaVersion === 2)
          return workspace.projects.importProject(
            imported as components["schemas"]["ProjectInput"],
          );
        const selected = workspace.selected();
        if (!selected || imported.mediaId !== selected.id)
          throw new Error("Select the cut list's media before importing.");
        const segments = imported.segments as Segment[];
        const error = validateSegments(segments, selected.durationMs);
        if (error) throw new Error(error);
        workspace.updateTimeline({ segments });
        workspace.addMediaToProject();
        workspace.setStatus("Cut list imported. Save the project to keep it.");
      })
      .catch((error) =>
        workspace.setStatus(error instanceof Error ? error.message : "Cut list import failed."),
      );
    event.currentTarget.value = "";
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
              workspace.setProjectName(event.currentTarget.value);
              workspace.markDirty();
            }}
          />
          <p class="text-sm text-base-content/70">
            Project ID: {workspace.projectId()} · Revision {workspace.revision()}
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              class="btn btn-primary btn-sm"
              type="button"
              disabled={workspace.saveState() === "saving"}
              onClick={() => void workspace.projects.saveProject()}
            >
              {workspace.saveState() === "saving" ? "Saving…" : "Save project"}
            </button>
          </div>
        </section>
        <details class="mt-4">
          <summary>Interchange</summary>
          <p class="text-sm text-base-content/70">
            Import a saved cut list into this project. The selected media is required for legacy cut
            lists.
          </p>
          <label for="import-cut-list">Import cut list</label>
          <input
            id="import-cut-list"
            class="file-input file-input-sm file-input-bordered mt-1 w-full"
            type="file"
            accept="application/json,.json"
            onChange={importCutList}
          />
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
