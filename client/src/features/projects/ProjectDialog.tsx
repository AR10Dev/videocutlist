import { Effect } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Schema from "effect/Schema";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { ApiFailure, validInterchangeFileSize } from "../../api";
import { useWorkspace } from "../app/WorkspaceContext";
import { validateSegments } from "../preview/model";
import {
  Project as ProjectSchema,
  ProjectInput as ProjectInputSchema,
} from "../../generated/effect-api";
import { parseProjectJson } from "./lifecycle";
import {
  readInterchangeAttachment,
  readInterchangeFile,
  type InterchangeFormat,
} from "./interchange";
import { ProjectBrowser } from "./ProjectBrowser";

const legacySegmentsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    startMs: Schema.Number.check(Schema.isInt()),
    endMs: Schema.Number.check(Schema.isInt()),
    label: Schema.optionalKey(Schema.String),
    included: Schema.optionalKey(Schema.Boolean),
  }),
);

export function ProjectDialog(props: { onClose: () => void }) {
  const workspace = useWorkspace();
  let dialog: HTMLDialogElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let activeOperation: AbortController | undefined;
  let currentContext: string | undefined;
  const [pending, setPending] = createSignal(false);
  const objectUrls = new Set<string>();
  const revokeObjectUrl = (url: string) => {
    if (objectUrls.delete(url)) URL.revokeObjectURL(url);
  };
  const revokeObjectUrls = () => {
    for (const url of objectUrls) revokeObjectUrl(url);
  };
  const abortOperation = () => {
    activeOperation?.abort();
    activeOperation = undefined;
    setPending(false);
    revokeObjectUrls();
  };
  const context = () => `${workspace.projectId()}::${workspace.activeItemId() ?? ""}`;
  createEffect(() => {
    const next = context();
    if (currentContext !== undefined && currentContext !== next) abortOperation();
    currentContext = next;
  });
  onCleanup(() => abortOperation());

  onMount(() => {
    dialog?.showModal();
    closeButton?.focus();
  });

  const startOperation = () => {
    activeOperation?.abort();
    const controller = new AbortController();
    activeOperation = controller;
    setPending(true);
    return { controller, context: context() };
  };
  const isCurrent = (operation: ReturnType<typeof startOperation>) =>
    activeOperation === operation.controller &&
    !operation.controller.signal.aborted &&
    context() === operation.context;
  const finishOperation = (operation: ReturnType<typeof startOperation>) => {
    if (activeOperation === operation.controller) {
      activeOperation = undefined;
      setPending(false);
    }
  };
  const importCutList = (event: Event & { currentTarget: HTMLInputElement }) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!validInterchangeFileSize(file.size)) {
      workspace.setStatus("Cut list exceeds the 1 MiB limit.");
      return;
    }
    const operation = startOperation();
    const format: InterchangeFormat | undefined = file.name.toLowerCase().endsWith(".csv")
      ? "csv"
      : /\.(?:txt|chapters)$/i.test(file.name)
        ? "chapters"
        : undefined;
    void readInterchangeFile(file, operation.controller.signal)
      .then(async (text) => {
        if (!isCurrent(operation)) return;
        if (format) {
          const projectId = workspace.projectId();
          const itemId = workspace.activeItemId();
          if (!itemId) throw new Error("Select a project item before importing a cut list.");
          if (workspace.dirty() && !(await workspace.projects.saveProject()))
            throw new Error("Save the project before importing a cut list.");
          if (!isCurrent(operation)) return;
          const mutation = workspace.server.generatedApi?.mutation("default", "importInterchange");
          if (!mutation) throw new Error("Generated project API is not configured.");
          const release = workspace.server.registry.mount(mutation);
          try {
            workspace.server.registry.set(mutation, {
              params: { projectId, format },
              query: { itemId },
              payload: text,
            });
            const response = await Effect.runPromise(
              AtomRegistry.getResult(workspace.server.registry, mutation, {
                suspendOnWaiting: true,
              }),
              { signal: operation.controller.signal },
            );
            const saved = Schema.decodeUnknownSync(ProjectSchema)(response);
            if (saved.id !== projectId) throw new Error("Imported project response is invalid.");
          } finally {
            workspace.server.registry.set(mutation, Atom.Reset);
            release();
          }
          if (isCurrent(operation))
            await workspace.projects.loadProject(projectId, undefined, true);
          return;
        }
        const imported = parseProjectJson(text);
        if (imported.schemaVersion === 2) {
          const parsed = Schema.decodeUnknownSync(ProjectInputSchema)({ ...imported, revision: 0 });
          const document = {
            ...parsed,
            items: parsed.items.map((item) => ({
              ...item,
              segments: item.segments.map((segment) => ({ ...segment })),
              ...(item.editorState ? { editorState: { ...item.editorState } } : {}),
              exportOptions: {
                ...item.exportOptions,
                streamIndexes: item.exportOptions.streamIndexes
                  ? [...item.exportOptions.streamIndexes]
                  : undefined,
              },
            })),
          };
          await workspace.projects.importProject(document);
          return;
        }
        const selected = workspace.selected();
        if (!selected || imported.mediaId !== selected.id)
          throw new Error("Select the cut list's media before importing.");
        const segments = Schema.decodeUnknownSync(legacySegmentsSchema)(imported.segments).map(
          (segment) => ({ ...segment }),
        );
        const error = validateSegments(segments, selected.durationMs);
        if (error) throw new Error(error);
        if (!isCurrent(operation)) return;
        workspace.updateTimeline({ segments });
        workspace.addMediaToProject();
        workspace.setStatus("Cut list imported. Save the project to keep it.");
      })
      .catch((error: unknown) => {
        if (operation.controller.signal.aborted || !isCurrent(operation)) return;
        workspace.setStatus(
          error instanceof ApiFailure
            ? error.message
            : error instanceof Error && error.message !== ""
              ? error.message
              : "Cut list import failed.",
        );
      })
      .finally(() => finishOperation(operation));
  };
  const exportCutList = async (format: InterchangeFormat) => {
    const itemId = workspace.activeItemId();
    if (!itemId) return;
    const operation = startOperation();
    const projectId = workspace.projectId();
    try {
      if (workspace.dirty() && !(await workspace.projects.saveProject()))
        throw new Error("Save the project before exporting a cut list.");
      if (!isCurrent(operation)) return;
      const attachment = await readInterchangeAttachment(
        workspace.server.api,
        projectId,
        itemId,
        format,
        operation.controller.signal,
      );
      if (!isCurrent(operation)) return;
      const url = URL.createObjectURL(attachment.blob);
      objectUrls.add(url);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.filename;
      anchor.click();
      setTimeout(() => revokeObjectUrl(url), 0);
      workspace.setStatus(`${format === "csv" ? "CSV" : "Chapters"} cut list downloaded.`);
    } catch (error) {
      if (operation.controller.signal.aborted || !isCurrent(operation)) return;
      workspace.setStatus(
        error instanceof ApiFailure
          ? error.message
          : error instanceof Error && error.message !== ""
            ? error.message
            : "Cut list export failed.",
      );
    } finally {
      finishOperation(operation);
    }
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
              onClick={() => void exportCutList("csv")}
            >
              Download CSV cut list
            </button>
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              disabled={pending() || !workspace.activeItemId()}
              onClick={() => void exportCutList("chapters")}
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
