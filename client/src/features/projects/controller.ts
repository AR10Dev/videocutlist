import type * as EffectApiTypes from "../../generated/effect-api";
import { createSignal, type Accessor, type Setter } from "solid-js";
import { Cause, Effect, Exit, Fiber } from "effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { Fiber as FiberHandle } from "effect/Fiber";
import { ApiFailure } from "../../api";
import { readServerAtom, type ServerState } from "../app/server";
import {
  confirmDiscard,
  newProjectId,
  recentProjects,
  recentProjectsKey,
  validProjectId,
  parseProjectRecovery,
  type ProjectRecovery,
  type RecentProject,
} from "./lifecycle";
import {
  restoreProjectItem,
  serializeProjectItem,
  type EditableProjectItem,
  type ExportContainer,
} from "./model";
import { validateSegments } from "../preview/model";
import type { TimelineHistory } from "../editor/timeline";
import type { AppSettings } from "../settings/model";

type Project = EffectApiTypes.Project;
type GeneratedProject = import("../../generated/effect-api").Project;
type Media = EffectApiTypes.Media;
export type SaveState = "unsaved" | "saving" | "saved" | "failed";
const recoveryKey = "videocutlist.project-recovery.v1";

const errorCode = (failure: unknown): string | undefined => {
  if (failure instanceof ApiFailure) return failure.code;
  if (typeof failure !== "object" || failure === null || !("error" in failure)) return;
  const error = failure.error;
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
};

const readRecovery = (): ProjectRecovery | undefined => {
  try {
    return parseProjectRecovery(JSON.parse(localStorage.getItem(recoveryKey) ?? "null"));
  } catch {
    return;
  }
};

export type ProjectsControllerDeps = {
  server: ServerState;
  selected: Accessor<Media | undefined>;
  projectId: Accessor<string>;
  setProjectId: Setter<string>;
  projectName: Accessor<string>;
  setProjectName: Setter<string>;
  revision: Accessor<number>;
  setRevision: Setter<number>;
  dirty: Accessor<boolean>;
  setDirty: Setter<boolean>;
  editorVersion: Accessor<number>;
  contextKey: Accessor<string>;
  projectItems: Accessor<EditableProjectItem[]>;
  setProjectItems: Setter<EditableProjectItem[]>;
  setSelectedExportItems: Setter<string[]>;
  setActiveItemId: Setter<string | undefined>;
  setSelected: Setter<Media | undefined>;
  setTimeline: Setter<TimelineHistory>;
  setPreviewCenterMs: (ms: number) => void;
  setRecent: Setter<{ id: string; label: string; lastOpened: number }[]>;
  settings: Accessor<AppSettings>;
  setMuted: Setter<boolean>;
  setExportMode: Setter<"merge" | "separate">;
  setExportSelection: Setter<"segments" | "gaps">;
  setStreamIndexes: Setter<number[]>;
  setCutStrategy: Setter<AppSettings["cutStrategy"]>;
  setExportContainer: Setter<ExportContainer>;
  setDestinationId: Setter<string>;
  setFilenameTemplate: Setter<string>;
  editableItems: () => EditableProjectItem[];
  resetEditorContext?: () => void;
  clearDetectionContext: () => void;
  setDiagnostics: () => void;
  setStatus: Setter<string>;
};

export function createProjectsController(deps: ProjectsControllerDeps) {
  let loadFiber: FiberHandle<void, never> | undefined;
  let saveFiber: FiberHandle<Project | undefined, never> | undefined;
  let autosaveFiber: FiberHandle<void, never> | undefined;
  let projectRequestVersion = 0;
  let contextVersion = 0;
  let pendingSave: "auto" | "explicit" | undefined;
  let disposed = false;
  const [saveState, setSaveState] = createSignal<SaveState>(
    deps.revision() > 0 && !deps.dirty() ? "saved" : "unsaved",
  );
  const [saveConflict, setSaveConflict] = createSignal(false);
  const [saveError, setSaveError] = createSignal("");
  const failSave = (message: string) => {
    setSaveError(message);
    setSaveState("failed");
    deps.setStatus(message);
  };
  const [recovery, setRecovery] = createSignal<ProjectRecovery | undefined>(readRecovery());
  const remember = (id: string, label: string) => {
    let recent: RecentProject[] = [];
    try {
      recent = recentProjects(JSON.parse(localStorage.getItem(recentProjectsKey) ?? "[]"));
    } catch {
      /* ignore malformed local state */
    }
    const next = [
      { id, label, lastOpened: Date.now() },
      ...recent.filter((item) => item.id !== id),
    ].slice(0, 20);
    deps.setRecent(next);
    try {
      localStorage.setItem(recentProjectsKey, JSON.stringify(next));
      localStorage.setItem("videocutlist.active-project.v2", id);
    } catch {
      // Recent projects are optional browser state; a durable save must still succeed.
    }
  };
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
    try {
      localStorage.setItem(recoveryKey, JSON.stringify(snapshot));
      setRecovery(snapshot);
    } catch {
      // Recovery is best effort and must not interrupt editing.
    }
  };
  const clearRecovery = (id?: string) => {
    const current = recovery();
    if (id && current && current.projectId !== id) return;
    try {
      localStorage.removeItem(recoveryKey);
    } catch {
      // Ignore unavailable browser storage.
    }
    setRecovery();
  };
  const interrupt = (fiber: FiberHandle<unknown, never> | undefined) => {
    if (fiber) void Effect.runFork(Fiber.interrupt(fiber));
  };
  const cancelAutosave = () => {
    interrupt(autosaveFiber);
    autosaveFiber = undefined;
    pendingSave = undefined;
    interrupt(saveFiber);
    saveFiber = undefined;
  };
  const performSave = Effect.gen(function* () {
    const snapshot = {
      project: deps.projectId(),
      media: deps.selected()?.id,
      editorVersion: deps.editorVersion(),
      context: contextVersion,
      revision: deps.revision(),
      name: deps.projectName(),
      items: deps.editableItems(),
    };
    if (!validProjectId(snapshot.project)) return void failSave("Project ID is invalid.");
    if (!snapshot.name.trim()) return void failSave("Project name is required.");
    if (!snapshot.items.length) return void failSave("Add media before saving.");
    for (const item of snapshot.items) {
      const error = validateSegments(item.timeline.present.segments, item.media.durationMs);
      if (error) return void failSave(`${item.media.name}: ${error}`);
    }
    const sameProject = () =>
      !disposed && snapshot.context === contextVersion && snapshot.project === deps.projectId();
    setSaveState("saving");
    const mutation = deps.server.generatedApi?.mutation("default", "putProject");
    if (!mutation) return void failSave("Generated project API is not configured.");
    const result = yield* Effect.exit(
      Effect.acquireUseRelease(
        Effect.sync(() => deps.server.registry.mount(mutation)),
        () => {
          deps.server.registry.set(mutation, {
            params: { projectId: snapshot.project },
            payload: {
              revision: snapshot.revision,
              schemaVersion: 2,
              name: snapshot.name,
              items: snapshot.items.map(serializeProjectItem),
            },
          });
          return AtomRegistry.getResult(deps.server.registry, mutation, { suspendOnWaiting: true });
        },
        (release) => Effect.sync(release),
      ),
    );
    if (!sameProject()) return;
    if (Exit.isFailure(result)) {
      const failure = Cause.squash(result.cause);
      if (errorCode(failure) === "revision_conflict") {
        pendingSave = undefined;
        setSaveConflict(true);
        failSave(
          "Project changed on another client. Reload it or save local work as a new project.",
        );
      } else {
        failSave(
          failure instanceof ApiFailure
            ? failure.code === "invalid_project"
              ? failure.message
              : `Project save failed (${failure.status}). Retry when ready.`
            : failure instanceof Error
              ? `${failure.message} Retry when ready.`
              : "Project save failed. Retry when ready.",
        );
      }
      return;
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
    deps.setRevision(project.revision);
    if (!sameProject()) return;
    if (snapshot.editorVersion === deps.editorVersion() && snapshot.media === deps.selected()?.id) {
      deps.setProjectItems(snapshot.items);
      deps.setDirty(false);
      setSaveConflict(false);
      setSaveState("saved");
      clearRecovery(snapshot.project);
      remember(project.id, project.name);
      deps.setStatus(`Project saved (revision ${project.revision}).`);
    } else {
      deps.setDirty(true);
      setSaveState("unsaved");
      captureRecovery();
      pendingSave = pendingSave ?? "auto";
      deps.setStatus("Project saved; newer edits remain unsaved.");
    }
    return project;
  });
  const requestSave = (kind: "auto" | "explicit"): Promise<Project | undefined> => {
    if (disposed || (kind === "auto" && saveConflict())) return Promise.resolve(undefined);
    pendingSave = kind === "explicit" ? "explicit" : (pendingSave ?? "auto");
    if (!saveFiber) {
      const fiber: FiberHandle<Project | undefined, never> = Effect.runFork(
        Effect.gen(function* () {
          yield* Effect.yieldNow;
          let latest: Project | undefined;
          while (pendingSave && !disposed) {
            pendingSave = undefined;
            const saved = yield* performSave;
            if (saved) {
              latest = saved;
            } else {
              if (pendingSave !== "explicit") pendingSave = undefined;
              break;
            }
          }
          return latest;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (saveFiber === fiber) saveFiber = undefined;
            }),
          ),
        ),
      );
      saveFiber = fiber;
    }
    return Effect.runPromise(Fiber.await(saveFiber)).then((exit) =>
      Exit.isSuccess(exit) ? exit.value : undefined,
    );
  };
  const scheduleAutosave = () => {
    if (disposed) return;
    captureRecovery();
    if (saveConflict()) return;
    setSaveState("unsaved");
    interrupt(autosaveFiber);
    const fiber: FiberHandle<void, never> = Effect.runFork(
      Effect.sleep(750).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            void requestSave("auto");
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (autosaveFiber === fiber) autosaveFiber = undefined;
          }),
        ),
      ),
    );
    autosaveFiber = fiber;
  };
  const saveProject = () => {
    interrupt(autosaveFiber);
    autosaveFiber = undefined;
    captureRecovery();
    return requestSave("explicit");
  };
  const retrySave = () => (saveConflict() ? Promise.resolve(undefined) : saveProject());
  const loadProject = (
    id = deps.projectId(),
    imported?: Project,
    skipDiscardConfirmation = false,
  ): Promise<void> => {
    if (!validProjectId(id)) {
      deps.setStatus("Project ID is invalid.");
      return Promise.resolve();
    }
    if (
      !skipDiscardConfirmation &&
      !confirmDiscard(deps.dirty(), () => window.confirm("Discard unsaved changes?"))
    )
      return Promise.resolve();
    cancelAutosave();
    contextVersion++;
    const preserveConflict = !imported && id === deps.projectId() && saveConflict();
    if (!preserveConflict) setSaveConflict(false);
    const snapshotEditorVersion = deps.editorVersion();
    const snapshotProject = deps.projectId();
    const snapshotContext = deps.contextKey();
    deps.clearDetectionContext();
    deps.setDiagnostics();
    interrupt(loadFiber);
    const request = ++projectRequestVersion;
    const fiber: FiberHandle<void, never> = Effect.runFork(
      Effect.gen(function* () {
        yield* Effect.yieldNow;
        let loadedProject: Project | GeneratedProject;
        if (imported) {
          loadedProject = imported;
        } else {
          const projectResource = deps.server.project(id);
          deps.server.registry.refresh(projectResource);
          loadedProject = yield* readServerAtom(deps.server, projectResource);
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
        if (
          disposed ||
          request !== projectRequestVersion ||
          snapshotEditorVersion !== deps.editorVersion() ||
          snapshotProject !== deps.projectId() ||
          snapshotContext !== deps.contextKey() ||
          !restored.length
        )
          return;
        const first = restored[0];
        deps.resetEditorContext?.();
        deps.setProjectId(project.id);
        deps.setProjectName(project.name);
        deps.setRevision(project.revision);
        deps.setProjectItems(restored);
        const exportableItems = restored
          .filter(
            (item) =>
              item.timeline.present.segments.length > 0 &&
              !validateSegments(item.timeline.present.segments, item.media.durationMs),
          )
          .map((item) => item.id);
        deps.setSelectedExportItems(exportableItems.length ? exportableItems : [first.id]);
        deps.setActiveItemId(first.id);
        deps.setSelected(first.media);
        deps.setTimeline(first.timeline);
        deps.setPreviewCenterMs(first.timeline.present.playheadMs);
        setSaveConflict(false);
        deps.setMuted(first.muted);
        deps.setExportMode(first.exportOptions.mode ?? "merge");
        deps.setExportSelection(first.exportOptions.selection ?? "segments");
        deps.setStreamIndexes([...(first.exportOptions.streamIndexes ?? [])]);
        deps.setCutStrategy(first.exportOptions.cutStrategy ?? deps.settings().cutStrategy);
        deps.setExportContainer(first.exportOptions.container ?? "mkv");
        deps.setDestinationId(first.exportOptions.destinationId ?? "download");
        deps.setFilenameTemplate(
          first.exportOptions.filenameTemplate ?? deps.settings().filenameTemplate,
        );
        deps.setDirty(Boolean(imported));
        setSaveState(imported ? "unsaved" : "saved");
        if (!imported) {
          clearRecovery(project.id);
          remember(project.id, project.name);
        } else captureRecovery();
        deps.setStatus(
          imported ? "Cut list imported. Save the project to keep it." : "Project loaded.",
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = Cause.squash(cause);
            if (!disposed && request === projectRequestVersion)
              deps.setStatus(error instanceof Error ? error.message : "Project load failed.");
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (loadFiber === fiber) loadFiber = undefined;
          }),
        ),
      ),
    );
    loadFiber = fiber;
    return Effect.runPromise(Fiber.await(fiber)).then(() => undefined);
  };
  const newProject = () => {
    if (!confirmDiscard(deps.dirty(), () => window.confirm("Discard unsaved changes?"))) return;
    cancelAutosave();
    contextVersion++;
    deps.resetEditorContext?.();
    setSaveConflict(false);
    deps.clearDetectionContext();
    interrupt(loadFiber);
    loadFiber = undefined;
    ++projectRequestVersion;
    deps.setProjectId(newProjectId());
    deps.setProjectName("Untitled project");
    deps.setRevision(0);
    deps.setDirty(false);
    setSaveState("unsaved");
    clearRecovery();
    deps.setProjectItems([]);
    deps.setSelectedExportItems([]);
    deps.setActiveItemId();
    deps.setSelected();
    deps.setPreviewCenterMs(0);
    deps.setDiagnostics();
    deps.setTimeline({
      past: [],
      present: { playheadMs: 0, segments: [], zoom: 1 },
      future: [],
    });
    try {
      globalThis.localStorage?.removeItem("videocutlist.active-project.v2");
    } catch {
      // Remembered project is optional when browser storage is unavailable.
    }
    deps.setStatus("New project ready.");
  };
  const recoverProject = () => {
    const snapshot = recovery();
    if (!snapshot) return Promise.resolve();
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
  const saveAsNewProject = () => {
    cancelAutosave();
    contextVersion++;
    deps.resetEditorContext?.();
    interrupt(loadFiber);
    loadFiber = undefined;
    ++projectRequestVersion;
    setSaveConflict(false);
    deps.setProjectId(newProjectId());
    deps.setRevision(0);
    deps.setDirty(true);
    setSaveState("unsaved");
    captureRecovery();
    return requestSave("explicit");
  };
  const reloadRemoteProject = () => loadProject(deps.projectId(), undefined, true);
  let rememberedProject: string | null = null;
  try {
    rememberedProject = globalThis.localStorage?.getItem("videocutlist.active-project.v2") ?? null;
  } catch {
    // Browser storage may deny reads without affecting projects.
  }
  if (!recovery() && validProjectId(rememberedProject))
    queueMicrotask(() => {
      if (!disposed) void loadProject(rememberedProject);
    });

  return {
    saveProject,
    retrySave,
    scheduleAutosave,
    captureRecovery,
    saveAsNewProject,
    reloadRemoteProject,
    recovery,
    recoverProject,
    dismissRecovery,
    saveConflict,
    saveState,
    saveError,
    loadProject,
    importProject: (document: EffectApiTypes.ProjectInput) => {
      const id = newProjectId();
      return loadProject(id, { ...document, id, revision: 0, updatedAt: new Date().toISOString() });
    },
    newProject,
    dispose: () => {
      disposed = true;
      cancelAutosave();
      interrupt(loadFiber);
      loadFiber = undefined;
      ++projectRequestVersion;
      contextVersion++;
    },
  };
}
