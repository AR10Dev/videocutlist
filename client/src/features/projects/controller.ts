import { createSignal, type Accessor, type Setter } from "solid-js";
import type { QueryClient } from "@tanstack/solid-query";
import type { ApiClient } from "../../api";
import type { components } from "../../generated/api";
import {
  confirmDiscard,
  newProjectId,
  recentProjects,
  recentProjectsKey,
  validProjectId,
  parseProjectJson,
} from "./lifecycle";
import { restoreProjectItem, serializeProjectItem, type EditableProjectItem } from "./model";
import { validateSegments } from "../preview/model";
import type { TimelineHistory } from "../editor/timeline";
import type { AppSettings } from "../settings/model";

type Project = components["schemas"]["Project"];
type Media = components["schemas"]["Media"];
export type SaveState = "unsaved" | "saving" | "saved" | "failed";
export type ProjectRecovery = {
  version: 1;
  projectId: string;
  revision: number;
  schemaVersion: 2;
  name: string;
  items: components["schemas"]["ProjectItem"][];
  savedAt: number;
};

const recoveryKey = "videocutlist.project-recovery.v1";

const readRecovery = (): ProjectRecovery | undefined => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(recoveryKey) ?? "null");
    if (!value || typeof value !== "object") return;
    const candidate = value as Partial<ProjectRecovery>;
    if (
      candidate.version !== 1 ||
      !validProjectId(candidate.projectId) ||
      typeof candidate.revision !== "number" ||
      !Number.isSafeInteger(candidate.revision) ||
      candidate.revision < 0 ||
      candidate.schemaVersion !== 2 ||
      typeof candidate.name !== "string" ||
      !candidate.name.trim() ||
      !Array.isArray(candidate.items) ||
      !candidate.items.length ||
      typeof candidate.savedAt !== "number" ||
      !Number.isSafeInteger(candidate.savedAt) ||
      candidate.savedAt < 0
    )
      return;
    parseProjectJson(
      JSON.stringify({ schemaVersion: 2, name: candidate.name, items: candidate.items }),
    );
    return candidate as ProjectRecovery;
  } catch {
    return;
  }
};

export type ProjectsControllerDeps = {
  api: ApiClient;
  queryClient: QueryClient;
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
  projectItems: Accessor<EditableProjectItem[]>;
  setProjectItems: Setter<EditableProjectItem[]>;
  setSelectedExportItems: Setter<string[]>;
  setActiveItemId: Setter<string | undefined>;
  setSelected: Setter<Media | undefined>;
  setTimeline: Setter<TimelineHistory>;
  setPreviewCenterMs: (ms: number) => void;
  setMedia: Setter<Media[]>;
  setRecent: Setter<{ id: string; label: string; lastOpened: number }[]>;
  settings: Accessor<AppSettings>;
  setMuted: Setter<boolean>;
  setExportMode: Setter<"merge" | "separate">;
  setExportSelection: Setter<"segments" | "gaps">;
  setStreamIndexes: Setter<number[]>;
  setCutStrategy: Setter<AppSettings["cutStrategy"]>;
  setDestinationId: Setter<string>;
  setFilenameTemplate: Setter<string>;
  editableItems: () => EditableProjectItem[];
  clearDetectionContext: () => void;
  setDiagnostics: () => void;
  setStatus: Setter<string>;
};

export function createProjectsController(deps: ProjectsControllerDeps) {
  let projectRequest: AbortController | undefined;
  let projectRequestVersion = 0;
  let saveRequest: AbortController | undefined;
  let contextVersion = 0;
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSave: "auto" | "explicit" | undefined;
  let saveLoop: Promise<Project | undefined> | undefined;
  let disposed = false;
  const [saveState, setSaveState] = createSignal<SaveState>(
    deps.revision() > 0 && !deps.dirty() ? "saved" : "unsaved",
  );
  const [saveConflict, setSaveConflict] = createSignal(false);
  const [recovery, setRecovery] = createSignal<ProjectRecovery | undefined>(readRecovery());
  const remember = (id: string, label: string) => {
    let recent: ReturnType<typeof recentProjects> = [];
    try {
      recent = recentProjects(JSON.parse(localStorage.getItem(recentProjectsKey) ?? "[]"));
    } catch {
      /* ignore malformed local state */
    }
    const next = [
      { id, label, lastOpened: Date.now() },
      ...recent.filter((item) => (item as { id?: string }).id !== id),
    ].slice(0, 20);
    deps.setRecent(next);
    localStorage.setItem(recentProjectsKey, JSON.stringify(next));
    localStorage.setItem("videocutlist.active-project.v2", id);
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
  const cancelAutosave = () => {
    if (autosaveTimer !== undefined) clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
    pendingSave = undefined;
    saveRequest?.abort();
  };
  const performSave = async (): Promise<Project | undefined> => {
    const snapshot = {
      project: deps.projectId(),
      media: deps.selected()?.id,
      editorVersion: deps.editorVersion(),
      context: contextVersion,
      revision: deps.revision(),
      name: deps.projectName(),
      items: deps.editableItems(),
    };
    if (!validProjectId(snapshot.project)) {
      setSaveState("failed");
      return void deps.setStatus("Project ID is invalid.");
    }
    if (!snapshot.items.length) {
      setSaveState("failed");
      return void deps.setStatus("Add media before saving.");
    }
    for (const item of snapshot.items) {
      const error = validateSegments(item.timeline.present.segments, item.media.durationMs);
      if (error) {
        setSaveState("failed");
        return void deps.setStatus(`${item.media.name}: ${error}`);
      }
    }
    const serializedItems = snapshot.items.map(serializeProjectItem);
    const controller = new AbortController();
    saveRequest = controller;
    setSaveState("saving");
    try {
      const response = await deps.api.request(`projects/${encodeURIComponent(snapshot.project)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          revision: snapshot.revision,
          schemaVersion: 2,
          name: snapshot.name,
          items: serializedItems,
        }),
      });
      if (controller.signal.aborted || disposed) return;
      const sameProject =
        snapshot.context === contextVersion && snapshot.project === deps.projectId();
      if (response.status === 409) {
        if (sameProject) {
          pendingSave = undefined;
          setSaveConflict(true);
          setSaveState("failed");
          deps.setStatus(
            "Project changed on another client. Reload it or save local work as a new project.",
          );
        }
        return;
      }
      if (!response.ok) {
        if (sameProject) {
          setSaveState("failed");
          deps.setStatus(`Project save failed (${response.status}). Retry when ready.`);
        }
        return;
      }
      const project = (await response.json()) as Project;
      if (!sameProject) return project;
      deps.setRevision(project.revision);
      await deps.queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      const current =
        snapshot.editorVersion === deps.editorVersion() && snapshot.media === deps.selected()?.id;
      if (current) {
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
    } catch (error) {
      if (!controller.signal.aborted && !disposed && snapshot.context === contextVersion) {
        setSaveState("failed");
        deps.setStatus(
          error instanceof Error
            ? `${error.message} Retry when ready.`
            : "Project save failed. Retry when ready.",
        );
      }
    } finally {
      if (saveRequest === controller) saveRequest = undefined;
    }
  };
  const runSaveLoop = async (): Promise<Project | undefined> => {
    let latest: Project | undefined;
    while (pendingSave && !disposed) {
      pendingSave = undefined;
      const result = await performSave();
      if (result) {
        latest = result;
        continue;
      }
      if (pendingSave !== "explicit") pendingSave = undefined;
      break;
    }
    return latest;
  };
  const requestSave = (kind: "auto" | "explicit") => {
    if (disposed || (kind === "auto" && saveConflict())) return Promise.resolve(undefined);
    pendingSave = kind === "explicit" ? "explicit" : (pendingSave ?? "auto");
    if (saveLoop) return saveLoop;
    const loop = runSaveLoop();
    saveLoop = loop;
    void loop.then(
      () => {
        if (saveLoop === loop) saveLoop = undefined;
      },
      () => {
        if (saveLoop === loop) saveLoop = undefined;
      },
    );
    return loop;
  };
  const scheduleAutosave = () => {
    captureRecovery();
    if (saveConflict()) return;
    setSaveState("unsaved");
    if (autosaveTimer !== undefined) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = undefined;
      void requestSave("auto");
    }, 750);
  };
  const saveProject = () => {
    if (autosaveTimer !== undefined) clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
    captureRecovery();
    return requestSave("explicit");
  };
  const retrySave = () => {
    if (saveConflict()) return Promise.resolve(undefined);
    return saveProject();
  };
  const loadProject = async (
    id = deps.projectId(),
    imported?: Project,
    skipDiscardConfirmation = false,
  ) => {
    if (!validProjectId(id)) return void deps.setStatus("Project ID is invalid.");
    if (
      !skipDiscardConfirmation &&
      !confirmDiscard(deps.dirty(), () => window.confirm("Discard unsaved changes?"))
    )
      return;
    cancelAutosave();
    contextVersion++;
    setSaveConflict(false);
    const snapshotEditorVersion = deps.editorVersion();
    const snapshotProject = deps.projectId();
    deps.clearDetectionContext();
    deps.setDiagnostics();
    projectRequest?.abort();
    const controller = new AbortController();
    projectRequest = controller;
    const request = ++projectRequestVersion;
    try {
      let project = imported;
      if (!project) {
        const response = await deps.api.request(`projects/${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Project load failed (${response.status}).`);
        project = (await response.json()) as Project;
      }
      const restored = await Promise.all(
        project.items.map(async (entry) => {
          const mediaResponse = await deps.api.request(
            `media/${encodeURIComponent(entry.mediaId)}`,
            { signal: controller.signal },
          );
          if (!mediaResponse.ok) throw new Error(`Media request failed (${mediaResponse.status}).`);
          const media = (await mediaResponse.json()) as Media;
          const error = validateSegments(entry.segments, media.durationMs);
          if (error) throw new Error(error);
          return restoreProjectItem(entry, media);
        }),
      );
      if (
        controller.signal.aborted ||
        request !== projectRequestVersion ||
        snapshotEditorVersion !== deps.editorVersion() ||
        snapshotProject !== deps.projectId() ||
        !restored.length
      )
        return;
      const first = restored[0];
      deps.setProjectId(project.id);
      deps.setProjectName(project.name);
      deps.setRevision(project.revision);
      deps.setProjectItems(restored);
      deps.setSelectedExportItems(
        restored
          .filter(
            (item) =>
              item.timeline.present.segments.length > 0 &&
              !validateSegments(item.timeline.present.segments, item.media.durationMs),
          )
          .map((item) => item.id),
      );
      deps.setActiveItemId(first.id);
      deps.setSelected(first.media);
      deps.setTimeline(first.timeline);
      deps.setPreviewCenterMs(first.timeline.present.playheadMs);
      deps.setMuted(first.muted);
      deps.setExportMode(first.exportOptions.mode ?? "merge");
      deps.setExportSelection(first.exportOptions.selection ?? "segments");
      deps.setStreamIndexes(first.exportOptions.streamIndexes ?? []);
      deps.setCutStrategy(first.exportOptions.cutStrategy ?? deps.settings().cutStrategy);
      deps.setDestinationId(first.exportOptions.destinationId ?? "download");
      deps.setFilenameTemplate(
        first.exportOptions.filenameTemplate ?? deps.settings().filenameTemplate,
      );
      deps.setMedia((known) => [
        ...known,
        ...restored.map((x) => x.media).filter((x) => !known.some((k) => k.id === x.id)),
      ]);
      deps.setDirty(Boolean(imported));
      setSaveState(imported ? "unsaved" : "saved");
      if (!imported) {
        clearRecovery(project.id);
        remember(project.id, project.name);
      } else captureRecovery();
      deps.setStatus(
        imported ? "Cut list imported. Save the project to keep it." : "Project loaded.",
      );
    } catch (error) {
      if (!controller.signal.aborted && request === projectRequestVersion)
        deps.setStatus(error instanceof Error ? error.message : "Project load failed.");
    }
  };
  const newProject = () => {
    if (!confirmDiscard(deps.dirty(), () => window.confirm("Discard unsaved changes?"))) return;
    cancelAutosave();
    contextVersion++;
    setSaveConflict(false);
    deps.clearDetectionContext();
    projectRequest?.abort();
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
    localStorage.removeItem("videocutlist.active-project.v2");
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
    setSaveConflict(false);
    deps.setProjectId(newProjectId());
    deps.setRevision(0);
    deps.setDirty(true);
    setSaveState("unsaved");
    captureRecovery();
    return requestSave("explicit");
  };
  const reloadRemoteProject = () => loadProject(deps.projectId(), undefined, true);
  const rememberedProject = localStorage.getItem("videocutlist.active-project.v2");
  if (!recovery() && validProjectId(rememberedProject))
    queueMicrotask(() => void loadProject(rememberedProject));

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
    loadProject,
    importProject: (document: components["schemas"]["ProjectInput"]) => {
      const id = newProjectId();
      return loadProject(id, { ...document, id, revision: 0, updatedAt: new Date().toISOString() });
    },
    newProject,
    dispose: () => {
      disposed = true;
      cancelAutosave();
      projectRequest?.abort();
      ++projectRequestVersion;
      contextVersion++;
    },
  };
}
