import type * as EffectApiTypes from "../../generated/effect-api";
import { type Accessor, type Setter } from "solid-js";
import { useAtomValue } from "@effect/atom-solid";
import { Cause, Effect, Exit } from "effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { ApiFailure, apiErrorCode } from "../../api";
import { readServerAtom, runServerMutation, useServerAtom, type ServerState } from "../app/server";
import {
  newProjectId,
  recentProjectsKey,
  validProjectId,
  recoverySchema,
  recoveryKey,
  rememberedProjectKey,
  rememberedProjectSchema,
  recentProjectsSchema,
  type ProjectRecovery,
} from "./lifecycle";
import { restoreProjectItem, serializeProjectItem, type EditableProjectItem } from "./model";
import { validateSegments } from "../preview/model";
import type { TimelineHistory } from "../editor/timeline";
import type { AppSettings } from "../settings/model";

type Project = EffectApiTypes.Project;
type Media = EffectApiTypes.Media;
export type SaveState = "unsaved" | "saving" | "saved" | "failed";

export type ProjectsControllerDeps = {
  server: ServerState;
  selected: Accessor<Media | undefined>;
  projectId: Accessor<string>;
  activeItemId: Accessor<string | undefined>;
  projectName: Accessor<string>;
  revision: Accessor<number>;
  setRevision: Setter<number>;
  dirty: Accessor<boolean>;
  setDirty: Setter<boolean>;
  editorVersion: Accessor<number>;
  contextKey: Accessor<string>;
  projectItems: Accessor<EditableProjectItem[]>;
  setProjectItems: Setter<EditableProjectItem[]>;
  setSelectedExportItems: Setter<string[]>;
  replaceContext: (context: {
    projectId: string;
    projectName: string;
    revision: number;
    activeItemId?: string;
    selected?: Media;
    dirty: boolean;
  }) => void;
  replaceTimeline: (history: TimelineHistory) => void;
  setPreviewCenterMs: (ms: number) => void;
  settings: Accessor<AppSettings>;
  setMuted: Setter<boolean>;
  editableItems: () => EditableProjectItem[];
  clearDetectionContext: () => void;
  setDiagnostics: () => void;
  setStatus: Setter<string>;
};

export function createProjectsController(deps: ProjectsControllerDeps) {
  const { registry, runtime } = deps.server;
  let disposed = false;
  const conflict = Atom.keepAlive(Atom.make(false));
  const observedConflict = useAtomValue(() => conflict);
  const saveConflict = () => {
    observedConflict();
    return registry.get(conflict);
  };
  const setSaveConflict = (value: boolean) => registry.set(conflict, value);
  const pendingSave = Atom.keepAlive(Atom.make<"auto" | "explicit" | undefined>(undefined));
  const recoveryValue = deps.server.persistence.value({
    key: recoveryKey,
    schema: recoverySchema,
    defaultValue: null,
    removeWhen: (value) => value === null,
  });
  const recentValue = deps.server.persistence.value({
    key: recentProjectsKey,
    schema: recentProjectsSchema,
    defaultValue: [],
  });
  const rememberedValue = deps.server.persistence.value({
    key: rememberedProjectKey,
    schema: rememberedProjectSchema,
    defaultValue: null,
    removeWhen: (value) => value === null,
  });
  const observedRecovery = useAtomValue(() => recoveryValue.value);
  const recovery = () => {
    observedRecovery();
    return registry.get(recoveryValue.value) ?? undefined;
  };
  const observedRestoration = useAtomValue(() => recoveryValue.status);
  const restoration = () => {
    observedRestoration();
    return registry.get(recoveryValue.status);
  };
  const observedRecent = useAtomValue(() => recentValue.value);
  const recent = () => {
    observedRecent();
    return registry.get(recentValue.value);
  };
  const initialized = Effect.gen(function* () {
    for (const value of [recoveryValue, recentValue, rememberedValue])
      yield* AtomRegistry.getResult(registry, value.initialize, { suspendOnWaiting: true });
  });
  const rememberCommand = runtime.fn(({ id, label }: { id: string; label: string }) =>
    initialized.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (disposed || id !== deps.projectId()) return;
          registry.set(
            recentValue.value,
            [
              { id, label, lastOpened: Date.now() },
              ...recent().filter((item) => item.id !== id),
            ].slice(0, 20),
          );
          registry.set(rememberedValue.value, id);
        }),
      ),
    ),
  );
  const releaseRemember = registry.mount(rememberCommand);
  const remember = (id: string, label: string) => registry.set(rememberCommand, { id, label });
  const captureRecovery = () => {
    if (!deps.dirty()) return;
    const items = deps.editableItems();
    if (!items.length) return;
    const snapshot: ProjectRecovery = {
      version: 1,
      projectId: deps.projectId(),
      revision: deps.revision(),
      schemaVersion: 2,
      name: deps.projectName(),
      items: items.map(serializeProjectItem),
      savedAt: Date.now(),
    };
    registry.set(recoveryValue.value, snapshot);
  };
  const clearRecoveryCommand = runtime.fn(
    (request: { id?: string; captured: typeof recoverySchema.Type; editorVersion: number }) =>
      initialized.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (disposed || request.editorVersion !== deps.editorVersion()) return;
            if (
              request.id &&
              (recovery()?.projectId !== request.id ||
                registry.get(recoveryValue.value) !== request.captured)
            )
              return;
            registry.set(recoveryValue.value, null);
          }),
        ),
      ),
  );
  const releaseClearRecovery = registry.mount(clearRecoveryCommand);
  const clearRecovery = (id?: string) =>
    registry.set(clearRecoveryCommand, {
      id,
      captured: registry.get(recoveryValue.value),
      editorVersion: deps.editorVersion(),
    });
  const performSave = Effect.gen(function* () {
    const snapshot = {
      project: deps.projectId(),
      editorVersion: deps.editorVersion(),
      context: deps.contextKey(),
      revision: deps.revision(),
      name: deps.projectName(),
      items: deps.editableItems(),
    };
    if (!validProjectId(snapshot.project))
      return yield* Effect.fail(new Error("Project ID is invalid."));
    if (!snapshot.name.trim()) return yield* Effect.fail(new Error("Project name is required."));
    if (Array.from(snapshot.name).length > 120)
      return yield* Effect.fail(new Error("Project name must be 120 Unicode characters or fewer."));
    if (!snapshot.items.length) return yield* Effect.fail(new Error("Add media before saving."));
    for (const item of snapshot.items) {
      const error = validateSegments(item.timeline.present.segments, item.media.durationMs);
      if (error) return yield* Effect.fail(new Error(`${item.media.name}: ${error}`));
    }
    // Serialize before yielding: later edits must not alter the submitted document.
    const payload = {
      revision: snapshot.revision,
      schemaVersion: 2 as const,
      name: snapshot.name,
      items: snapshot.items.map(serializeProjectItem),
    };
    const sameContext = () =>
      !disposed && snapshot.context === deps.contextKey() && snapshot.project === deps.projectId();
    const mutation = deps.server.generatedApi.mutation("default", "putProject");
    const result = yield* Effect.exit(
      runServerMutation(registry, mutation, {
        params: { projectId: snapshot.project },
        payload,
      }),
    );
    if (!sameContext()) return;
    if (Exit.isFailure(result)) {
      if (Cause.hasInterrupts(result.cause)) return yield* Effect.interrupt;
      const failure = Cause.squash(result.cause);
      if (apiErrorCode(failure) === "revision_conflict") {
        registry.set(pendingSave, undefined);
        setSaveConflict(true);
        return yield* Effect.fail(
          new Error(
            "Project changed on another client. Reload it or save local work as a new project.",
          ),
        );
      }
      return yield* Effect.fail(
        new Error(
          failure instanceof ApiFailure
            ? failure.code === "invalid_project"
              ? failure.message
              : `Project save failed (${failure.status}). Retry when ready.`
            : "Project save failed. Retry when ready.",
        ),
      );
    }
    const project: Project = {
      ...result.value,
      items: result.value.items.map((item) => ({
        ...item,
        segments: item.segments.map((segment) => ({ ...segment })),
        exportOptions: {
          ...item.exportOptions,
          streamIndexes: item.exportOptions.streamIndexes
            ? [...item.exportOptions.streamIndexes]
            : undefined,
        },
      })),
    };
    Atom.batch(() => {
      deps.setRevision(project.revision);
      setSaveConflict(false);
      if (snapshot.editorVersion === deps.editorVersion()) {
        deps.setDirty(false);
        clearRecovery(snapshot.project);
        remember(project.id, project.name);
        deps.setStatus(`Project saved (revision ${project.revision}).`);
      } else {
        deps.setDirty(true);
        captureRecovery();
        registry.update(pendingSave, (kind) => kind ?? "auto");
        // The queued document supersedes any debounce that has not fired yet.
        registry.set(autosaveCommand, Atom.Interrupt);
        deps.setStatus("Project saved; newer edits remain unsaved.");
      }
    });
    return project;
  });
  // Only this mounted command sends PUTs. Requests coalesce while it drains newer intent.
  const saveCommand = runtime.fn(() =>
    Effect.gen(function* () {
      yield* Effect.yieldNow;
      let latest: Project | undefined;
      while (registry.get(pendingSave) && !disposed) {
        registry.set(pendingSave, undefined);
        latest = yield* performSave;
      }
      return latest;
    }).pipe(
      Effect.tapError((error) => Effect.sync(() => deps.setStatus(error.message))),
      Effect.ensuring(Effect.sync(() => registry.set(pendingSave, undefined))),
    ),
  );
  const requestSave = (kind: "auto" | "explicit"): Effect.Effect<Project | undefined, Error> =>
    Effect.suspend(() => {
      if (disposed || (kind === "auto" && saveConflict())) return Effect.succeed(undefined);
      registry.update(pendingSave, (pending) =>
        kind === "explicit" ? "explicit" : (pending ?? "auto"),
      );
      if (!registry.get(saveCommand).waiting) registry.set(saveCommand, undefined);
      return AtomRegistry.getResult(registry, saveCommand, { suspendOnWaiting: true });
    });
  const autosaveCommand = runtime.fn(() =>
    Effect.sleep(750).pipe(Effect.flatMap(() => requestSave("auto"))),
  );
  const releaseSave = registry.mount(saveCommand);
  const releaseAutosave = registry.mount(autosaveCommand);
  const observedSave = useServerAtom(() => saveCommand);
  const saveResult = () => {
    observedSave.result();
    return registry.get(saveCommand);
  };
  const saveError = () => {
    const result = saveResult();
    if (result.waiting || !AsyncResult.isFailure(result) || Cause.hasInterrupts(result.cause))
      return "";
    const failure = Cause.squash(result.cause);
    return failure instanceof Error ? failure.message : "Project save failed. Retry when ready.";
  };
  const saveState = (): SaveState =>
    saveResult().waiting
      ? "saving"
      : saveError()
        ? "failed"
        : deps.revision() > 0 && !deps.dirty()
          ? "saved"
          : "unsaved";
  const cancelAutosave = () => {
    registry.set(autosaveCommand, Atom.Interrupt);
    registry.set(saveCommand, Atom.Interrupt);
    registry.set(pendingSave, undefined);
  };
  const scheduleAutosave = () => {
    if (disposed) return;
    captureRecovery();
    if (saveConflict()) return;
    if (!registry.get(saveCommand).waiting) registry.set(saveCommand, Atom.Reset);
    registry.set(autosaveCommand, undefined);
  };
  const saveProjectEffect = () =>
    Effect.suspend(() => {
      if (disposed) return Effect.succeed(undefined);
      registry.set(autosaveCommand, Atom.Interrupt);
      captureRecovery();
      return requestSave("explicit");
    });
  const explicitSaveCommand = runtime.fn(() => saveProjectEffect());
  const releaseExplicitSave = registry.mount(explicitSaveCommand);
  const saveProject = () => registry.set(explicitSaveCommand, undefined);
  const retrySave = () => {
    if (!saveConflict()) saveProject();
  };
  type LoadRequest = {
    id: string;
    imported?: Project;
    editorVersion: number;
    project: string;
    context: string;
    media?: string;
  };
  const isCurrentLoad = (request: LoadRequest) =>
    !disposed &&
    request.editorVersion === deps.editorVersion() &&
    request.project === deps.projectId() &&
    request.context === deps.contextKey() &&
    request.media === deps.selected()?.id;
  // The mounted native command interrupts superseded reads; context guards also reject edits.
  const performLoad = (request: LoadRequest) =>
    Effect.gen(function* () {
      cancelAutosave();
      yield* Effect.yieldNow;
      const { id, imported } = request;
      let loadedProject: Project;
      if (imported) loadedProject = imported;
      else {
        const resource = deps.server.project(id);
        deps.server.registry.refresh(resource);
        loadedProject = yield* readServerAtom(deps.server, resource);
      }
      const project: Project = {
        ...loadedProject,
        items: loadedProject.items.map((item) => ({
          ...item,
          segments: item.segments.map((segment) => ({ ...segment })),
          exportOptions: {
            ...item.exportOptions,
            streamIndexes: item.exportOptions.streamIndexes
              ? [...item.exportOptions.streamIndexes]
              : undefined,
          },
        })),
      };
      const restored = yield* Effect.forEach(
        project.items,
        (entry) =>
          Effect.gen(function* () {
            const media = yield* readServerAtom(deps.server, deps.server.media(entry.mediaId));
            const error = validateSegments(
              entry.segments.map((segment) => ({ ...segment })),
              media.durationMs,
            );
            if (error) return yield* Effect.fail(new Error(error));
            return restoreProjectItem(entry, media);
          }),
        { concurrency: "unbounded" },
      );
      if (!isCurrentLoad(request)) return "stale" as const;
      if (!restored.length) return yield* Effect.fail(new Error("Project has no media."));
      Atom.batch(() => {
        const first = restored[0];
        deps.clearDetectionContext();
        deps.setDiagnostics();
        deps.replaceContext({
          projectId: project.id,
          projectName: project.name,
          revision: project.revision,
          activeItemId: first.id,
          selected: first.media,
          dirty: Boolean(imported),
        });
        deps.setProjectItems(restored);
        const exportableItems = restored
          .filter(
            (item) =>
              item.timeline.present.segments.length > 0 &&
              !validateSegments(item.timeline.present.segments, item.media.durationMs),
          )
          .map((item) => item.id);
        deps.setSelectedExportItems(exportableItems.length ? exportableItems : [first.id]);
        deps.replaceTimeline(first.timeline);
        deps.setPreviewCenterMs(first.timeline.present.playheadMs);
        setSaveConflict(false);
        deps.setMuted(first.muted);
        if (!imported) {
          remember(project.id, project.name);
        } else captureRecovery();
        deps.setStatus(
          imported ? "Cut list imported. Save the project to keep it." : "Project loaded.",
        );
      });
      return "loaded" as const;
    }).pipe(
      Effect.mapError(
        () => new Error("Project could not be loaded. Check its media and try again."),
      ),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (isCurrentLoad(request)) deps.setStatus(error.message);
        }),
      ),
    );
  const loadCommand = deps.server.runtime.fn(performLoad);
  const releaseLoad = deps.server.registry.mount(loadCommand);
  const observedLoad = useServerAtom(() => loadCommand);
  const loadResult = () => {
    observedLoad.result();
    return deps.server.registry.get(loadCommand);
  };
  const loadProject = (
    id = deps.projectId(),
    imported?: Project,
    confirmed = !deps.dirty(),
  ): void => {
    if (disposed || !confirmed) return;
    if (!validProjectId(id)) {
      deps.setStatus("Project ID is invalid.");
      return;
    }
    deps.server.registry.set(loadCommand, {
      id,
      imported,
      editorVersion: deps.editorVersion(),
      project: deps.projectId(),
      context: deps.contextKey(),
      media: deps.selected()?.id,
    });
  };
  // Composed imports own their restoration fiber, so closing tools interrupts media reads too.
  const loadProjectEffect = (id: string, imported?: Project) =>
    Effect.suspend(() => {
      if (disposed) return Effect.void;
      if (!validProjectId(id)) return Effect.fail(new Error("Project ID is invalid."));
      return performLoad({
        id,
        imported,
        editorVersion: deps.editorVersion(),
        project: deps.projectId(),
        context: deps.contextKey(),
        media: deps.selected()?.id,
      }).pipe(Effect.asVoid);
    });
  const importProjectEffect = (document: EffectApiTypes.ProjectInput, confirmed: boolean) =>
    Effect.suspend(() => {
      if (!confirmed) return Effect.void;
      const id = newProjectId();
      return loadProjectEffect(id, {
        ...document,
        id,
        revision: 0,
        updatedAt: new Date().toISOString(),
      });
    });
  const newProjectCommand = deps.server.runtime.fn((confirmed: boolean) =>
    Effect.sync(() => {
      if (!confirmed || disposed) return;
      cancelAutosave();
      setSaveConflict(false);
      deps.clearDetectionContext();
      deps.server.registry.set(loadCommand, Atom.Interrupt);
      deps.replaceContext({
        projectId: newProjectId(),
        projectName: "Untitled project",
        revision: 0,
        dirty: false,
      });
      clearRecovery();
      deps.setProjectItems([]);
      deps.setSelectedExportItems([]);
      deps.setPreviewCenterMs(0);
      deps.setDiagnostics();
      deps.replaceTimeline({
        past: [],
        present: { playheadMs: 0, segments: [], zoom: 1 },
        future: [],
      });
      registry.set(rememberedValue.value, null);
      deps.setStatus("New project ready.");
    }),
  );
  const releaseNewProject = registry.mount(newProjectCommand);
  const newProject = (confirmed = !deps.dirty()) => {
    registry.set(newProjectCommand, confirmed);
    registry.get(newProjectCommand);
  };
  const recoverProject = () => {
    const snapshot = recovery();
    if (!snapshot) return;
    return loadProject(
      snapshot.projectId,
      {
        id: snapshot.projectId,
        revision: snapshot.revision,
        updatedAt: new Date(snapshot.savedAt).toISOString(),
        schemaVersion: 2,
        name: snapshot.name,
        items: snapshot.items,
      },
      true,
    );
  };
  const dismissRecovery = () => clearRecovery();
  const saveAsNewCommand = deps.server.runtime.fn(() =>
    Effect.sync(() => {
      if (disposed) return;
      cancelAutosave();
      deps.server.registry.set(loadCommand, Atom.Interrupt);
      setSaveConflict(false);
      deps.replaceContext({
        projectId: newProjectId(),
        projectName: deps.projectName(),
        revision: 0,
        dirty: true,
        selected: deps.selected(),
        activeItemId: deps.activeItemId(),
      });
      captureRecovery();
    }),
  );
  const saveAsNewAndSave = runtime.fn(() =>
    Effect.gen(function* () {
      registry.set(saveAsNewCommand, undefined);
      yield* AtomRegistry.getResult(registry, saveAsNewCommand, { suspendOnWaiting: true });
      return yield* saveProjectEffect();
    }),
  );
  const releaseSaveAsNew = registry.mount(saveAsNewAndSave);
  const saveAsNewProject = () => registry.set(saveAsNewAndSave, undefined);
  const reloadRemoteProject = () => loadProject(deps.projectId(), undefined, true);
  const startupContext = deps.contextKey();
  const startupVersion = deps.editorVersion();
  const startupCommand = runtime.fn(() =>
    initialized.pipe(
      Effect.flatMap(() => {
        const id = registry.get(rememberedValue.value);
        if (
          disposed ||
          recovery() ||
          !validProjectId(id) ||
          deps.dirty() ||
          startupContext !== deps.contextKey() ||
          startupVersion !== deps.editorVersion()
        )
          return Effect.void;
        registry.set(loadCommand, {
          id,
          editorVersion: deps.editorVersion(),
          project: deps.projectId(),
          context: deps.contextKey(),
          media: deps.selected()?.id,
        });
        return AtomRegistry.getResult(registry, loadCommand, { suspendOnWaiting: true }).pipe(
          Effect.asVoid,
          Effect.catch(() => Effect.void),
        );
      }),
    ),
  );
  const releaseStartup = registry.mount(startupCommand);
  registry.set(startupCommand, undefined);

  return {
    explicitSaveCommand,
    saveAsNewAndSave,
    loadCommand,
    saveProject,
    saveProjectEffect,
    saveResult,
    retrySave,
    scheduleAutosave,
    captureRecovery,
    saveAsNewProject,
    reloadRemoteProject,
    recovery,
    recent,
    restoration,
    restorationEffect: () =>
      AtomRegistry.getResult(registry, startupCommand, { suspendOnWaiting: true }),
    recoverProject,
    dismissRecovery,
    saveConflict,
    conflictAtom: conflict,
    saveState,
    saveError,
    loadProject,
    loadProjectEffect,
    importProjectEffect,
    loadResult,
    loadPending: () => loadResult().waiting,
    loadError: () => {
      const result = loadResult();
      return AsyncResult.isFailure(result) && !Cause.hasInterrupts(result.cause)
        ? new Error("Project could not be loaded. Check its media and try again.")
        : undefined;
    },
    importProject: (document: EffectApiTypes.ProjectInput, confirmed = !deps.dirty()) => {
      const id = newProjectId();
      return loadProject(
        id,
        { ...document, id, revision: 0, updatedAt: new Date().toISOString() },
        confirmed,
      );
    },
    newProject,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      registry.set(explicitSaveCommand, Atom.Interrupt);
      registry.set(saveAsNewAndSave, Atom.Interrupt);
      registry.set(newProjectCommand, Atom.Interrupt);
      releaseExplicitSave();
      releaseSaveAsNew();
      releaseNewProject();
      cancelAutosave();
      deps.server.registry.set(loadCommand, Atom.Interrupt);
      registry.set(startupCommand, Atom.Interrupt);
      registry.set(rememberCommand, Atom.Interrupt);
      registry.set(clearRecoveryCommand, Atom.Interrupt);
      releaseStartup();
      releaseRemember();
      releaseClearRecovery();
      releaseLoad();
      releaseSave();
      releaseAutosave();
    },
  };
}
