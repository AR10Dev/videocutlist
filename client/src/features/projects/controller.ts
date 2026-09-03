import type { Accessor, Setter } from "solid-js";
import type { QueryClient } from "@tanstack/solid-query";
import type { ApiClient } from "../../api";
import type { components } from "../../generated/api";
import {
  confirmDiscard,
  newProjectId,
  recentProjects,
  recentProjectsKey,
  validProjectId,
} from "./lifecycle";
import { restoreProjectItem, serializeProjectItem, type EditableProjectItem } from "./model";
import { validateSegments } from "../preview/model";
import type { TimelineHistory } from "../editor/timeline";
import type { AppSettings } from "../settings/model";

type Project = components["schemas"]["Project"];
type Media = components["schemas"]["Media"];
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
  let saveVersion = 0;
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
  const saveProject = async (): Promise<Project | undefined> => {
    const snapshotProject = deps.projectId();
    const snapshotMedia = deps.selected()?.id;
    const snapshotEditorVersion = deps.editorVersion();
    const request = ++saveVersion;
    saveRequest?.abort();
    const controller = new AbortController();
    saveRequest = controller;
    const items = deps.editableItems();
    if (!validProjectId(snapshotProject)) return void deps.setStatus("Project ID is invalid.");
    if (!items.length) return void deps.setStatus("Add media before saving.");
    for (const item of items) {
      const error = validateSegments(item.timeline.present.segments, item.media.durationMs);
      if (error) return void deps.setStatus(`${item.media.name}: ${error}`);
    }
    try {
      const response = await deps.api.request(`projects/${encodeURIComponent(snapshotProject)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          revision: deps.revision(),
          schemaVersion: 2,
          name: deps.projectName(),
          items: items.map(serializeProjectItem),
        }),
      });
      if (
        controller.signal.aborted ||
        request !== saveVersion ||
        snapshotEditorVersion !== deps.editorVersion() ||
        snapshotProject !== deps.projectId() ||
        snapshotMedia !== deps.selected()?.id
      )
        return;
      if (response.status === 409)
        return void deps.setStatus("Project changed on another client. Load latest before saving.");
      if (!response.ok) return void deps.setStatus(`Project save failed (${response.status}).`);
      const project = (await response.json()) as Project;
      deps.setProjectItems(items);
      deps.setRevision(project.revision);
      await deps.queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      deps.setDirty(false);
      remember(project.id, project.name);
      deps.setStatus(`Project saved (revision ${project.revision}).`);
      return project;
    } catch (error) {
      if (!controller.signal.aborted && request === saveVersion)
        deps.setStatus(error instanceof Error ? error.message : "Project save failed.");
    }
  };
  const loadProject = async (id = deps.projectId()) => {
    if (!validProjectId(id)) return void deps.setStatus("Project ID is invalid.");
    if (!confirmDiscard(deps.dirty(), () => window.confirm("Discard unsaved changes?"))) return;
    const snapshotEditorVersion = deps.editorVersion();
    const snapshotProject = deps.projectId();
    deps.clearDetectionContext();
    deps.setDiagnostics();
    projectRequest?.abort();
    const controller = new AbortController();
    projectRequest = controller;
    const request = ++projectRequestVersion;
    try {
      const response = await deps.api.request(`projects/${encodeURIComponent(id)}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Project load failed (${response.status}).`);
      const project = (await response.json()) as Project;
      const restored = await Promise.all(
        project.items.map(async (entry) => {
          const mediaResponse = await deps.api.request(
            `media/${encodeURIComponent(entry.mediaId)}`,
            { signal: controller.signal },
          );
          if (!mediaResponse.ok) throw new Error(`Media request failed (${mediaResponse.status}).`);
          return restoreProjectItem(entry, (await mediaResponse.json()) as Media);
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
      deps.setSelectedExportItems(restored.map((item) => item.id));
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
      deps.setDirty(false);
      remember(project.id, project.name);
      deps.setStatus("Project loaded.");
    } catch (error) {
      if (!controller.signal.aborted && request === projectRequestVersion)
        deps.setStatus(error instanceof Error ? error.message : "Project load failed.");
    }
  };
  const newProject = () => {
    if (!confirmDiscard(deps.dirty(), () => window.confirm("Discard unsaved changes?"))) return;
    deps.clearDetectionContext();
    projectRequest?.abort();
    ++projectRequestVersion;
    deps.setProjectId(newProjectId());
    deps.setProjectName("Untitled project");
    deps.setRevision(0);
    deps.setDirty(false);
    deps.setProjectItems([]);
    deps.setSelectedExportItems([]);
    deps.setActiveItemId();
    deps.setSelected();
    deps.setPreviewCenterMs(0);
    deps.setDiagnostics();
    deps.setTimeline({
      past: [],
      present: { playheadMs: 0, inMs: 0, outMs: 0, segments: [], zoom: 1 },
      future: [],
    });
    localStorage.removeItem("videocutlist.active-project.v2");
    deps.setStatus("New project ready.");
  };
  const rememberedProject = localStorage.getItem("videocutlist.active-project.v2");
  if (validProjectId(rememberedProject)) queueMicrotask(() => void loadProject(rememberedProject));

  return {
    saveProject,
    loadProject,
    newProject,
    dispose: () => {
      saveRequest?.abort();
      projectRequest?.abort();
      ++saveVersion;
      ++projectRequestVersion;
    },
  };
}
