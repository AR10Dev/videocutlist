import { Cause, Effect } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import { Project, ProjectImportResult, ProjectInput } from "../../generated/effect-api";
import type { WorkspaceController } from "../../app/controller";
import { runServerMutation } from "../../app/server";
import { validateSegments } from "../preview/model";
import {
  downloadInterchangeAttachment,
  readInterchangeAttachment,
  type InterchangeFormat,
  readInterchangeFile,
} from "./interchange";

/** One tools session owns import/export; interruption is local, not server rollback. */
export function createProjectToolsSession(
  workspace: Pick<
    WorkspaceController,
    "server" | "workspaceIdentity" | "selected" | "dirty" | "addMediaToProject" | "setStatus"
  > & {
    projects: Pick<
      WorkspaceController["projects"],
      "saveProjectEffect" | "loadProjectEffect" | "importProjectEffect"
    >;
    editor: Pick<WorkspaceController["editor"], "updateTimeline">;
  },
  confirmDiscard: () => boolean,
) {
  const { server } = workspace;
  const contextAtom = Atom.make((get) => {
    const state = get(workspace.workspaceIdentity);
    return JSON.stringify([
      state.projectId,
      state.activeItemId,
      state.editVersion,
      state.selectedMediaId,
      state.generation,
    ]);
  });
  const context = () => server.registry.get(contextAtom);
  const command = server.runtime.fn((operation: { file: File } | { format: InterchangeFormat }) => {
    const captured = context();
    const current = () => captured === context();
    return Effect.gen(function* () {
      const { projectId, activeItemId: itemId } = server.registry.get(workspace.workspaceIdentity);
      if ("format" in operation) {
        if (!itemId)
          return yield* Effect.fail(
            new Error("Select a project item before exporting a cut list."),
          );
        if (workspace.dirty() && !(yield* workspace.projects.saveProjectEffect()))
          return yield* Effect.fail(new Error("Save the project before exporting a cut list."));
        if (!current()) return;
        const attachment = yield* readInterchangeAttachment(
          server.api,
          projectId,
          itemId,
          operation.format,
        );
        if (!current()) return;
        yield* downloadInterchangeAttachment(attachment);
        if (current())
          workspace.setStatus(
            `${operation.format === "csv" ? "CSV" : "Chapters"} cut list downloaded.`,
          );
        return;
      }
      const file = operation.file;
      const text = yield* readInterchangeFile(file);
      if (!current()) return;
      const format = /\.csv$/i.test(file.name)
        ? ("csv" as const)
        : /\.(?:txt|chapters)$/i.test(file.name)
          ? ("chapters" as const)
          : undefined;
      if (format) {
        if (!itemId)
          return yield* Effect.fail(
            new Error("Select a project item before importing a cut list."),
          );
        if (workspace.dirty() && !(yield* workspace.projects.saveProjectEffect()))
          return yield* Effect.fail(new Error("Save the project before importing a cut list."));
        if (!current()) return;
        const response = yield* runServerMutation(
          server.registry,
          server.generatedApi.mutation("default", "importInterchange"),
          {
            params: { projectId, format },
            query: { itemId },
            payload: text,
          },
        );
        const saved = yield* Effect.try(() => Schema.decodeUnknownSync(Project)(response));
        if (saved.id !== projectId)
          return yield* Effect.fail(new Error("Imported project response is invalid."));
        if (current()) yield* workspace.projects.loadProjectEffect(projectId);
        return;
      }
      const response = yield* runServerMutation(
        server.registry,
        server.generatedApi.mutation("default", "importProjectFile"),
        { payload: { content: text } },
      );
      const imported = yield* Effect.try(() =>
        Schema.decodeUnknownSync(ProjectImportResult)(response),
      );
      const document = yield* Effect.try(() =>
        Schema.decodeUnknownSync(ProjectInput)(imported.document),
      );
      if (imported.sourceFormat === "legacy") {
        const selected = workspace.selected();
        if (!imported.mediaId || !selected || imported.mediaId !== selected.id)
          return yield* Effect.fail(new Error("Select the cut list's media before importing."));
        const item = document.items.find(({ mediaId }) => mediaId === imported.mediaId);
        if (!item) return yield* Effect.fail(new Error("Imported project response is invalid."));
        const segments = item.segments.map((segment) => ({ ...segment }));
        const error = validateSegments(segments, selected.durationMs);
        if (error) return yield* Effect.fail(new Error(error));
        if (!current()) return;
        workspace.editor.updateTimeline({ segments });
        workspace.addMediaToProject();
        workspace.setStatus("Cut list imported. Save the project to keep it.");
        return;
      }
      if (imported.mediaId !== undefined)
        return yield* Effect.fail(new Error("Imported project response is invalid."));
      if (!current()) return;
      const confirmed = !workspace.dirty() || confirmDiscard();
      if (current()) yield* workspace.projects.importProjectEffect(document, confirmed);
    }).pipe(
      Effect.mapError((error) => {
        const cause = Cause.isUnknownError(error) ? error.cause : error;
        return cause instanceof Error
          ? cause
          : new Error(
              "format" in operation ? "Cut list export failed." : "Cut list import failed.",
            );
      }),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (current()) workspace.setStatus(error.message);
        }),
      ),
    );
  });
  const release = server.registry.mount(command);
  let previousContext = context();
  const releaseContext = server.registry.subscribe(contextAtom, (next) => {
    if (next !== previousContext) server.registry.set(command, Atom.Interrupt);
    previousContext = next;
  });
  let closed = false;
  return {
    result: command,
    import(file: File) {
      if (closed) return;
      server.registry.set(command, Atom.Interrupt);
      server.registry.set(command, { file });
    },
    export(format: InterchangeFormat) {
      if (closed) return;
      server.registry.set(command, Atom.Interrupt);
      server.registry.set(command, { format });
    },
    interrupt() {
      server.registry.set(command, Atom.Interrupt);
    },
    close() {
      if (closed) return;
      closed = true;
      server.registry.set(command, Atom.Interrupt);
      releaseContext();
      release();
    },
  };
}
