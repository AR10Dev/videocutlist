import { QueryClient } from "@tanstack/solid-query";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "../src/api";
import { createTimelineHistory } from "../src/features/editor/timeline";
import { createProjectsController } from "../src/features/projects/controller";
import type { EditableProjectItem } from "../src/features/projects/model";
import { defaultSettings } from "../src/features/settings/model";
import type { components } from "../src/generated/api";

const media: components["schemas"]["Media"] = {
  id: "m_loaded",
  name: "loaded.mp4",
  durationMs: 10_000,
  sizeBytes: 1,
  container: "mp4",
  streams: {},
  etag: "v1",
};

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("projects controller", () => {
  it("does not apply a delayed load after the editor changes", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: memoryStorage(),
    });
    let resolveProject!: (response: Response) => void;
    const projectResponse = new Promise<Response>((resolve) => {
      resolveProject = resolve;
    });
    const request: ApiClient["request"] = (path) =>
      path.startsWith("projects/") ? projectResponse : Promise.resolve(Response.json(media));
    const api: ApiClient = {
      url: (path) => path,
      request,
      assetRequest: () => Promise.resolve(Response.json({})),
      interchangeRequest: () => Promise.resolve(Response.json({})),
    };
    const [selected, setSelected] = createSignal<components["schemas"]["Media"]>();
    const [projectId, setProjectId] = createSignal("p_current");
    const [projectName, setProjectName] = createSignal("Editing");
    const [revision, setRevision] = createSignal(0);
    const [dirty, setDirty] = createSignal(false);
    const [projectItems, setProjectItems] = createSignal<EditableProjectItem[]>([]);
    const [, setSelectedExportItems] = createSignal<string[]>([]);
    const [, setActiveItemId] = createSignal<string>();
    const [timeline, setTimeline] = createSignal(
      createTimelineHistory({ playheadMs: 0, inMs: 0, outMs: 0, segments: [], zoom: 1 }),
    );
    const [knownMedia, setMedia] = createSignal<components["schemas"]["Media"][]>([]);
    const [, setRecent] = createSignal<{ id: string; label: string; lastOpened: number }[]>([]);
    const [, setMuted] = createSignal(false);
    const [, setExportMode] = createSignal<"merge" | "separate">("merge");
    const [, setExportSelection] = createSignal<"segments" | "gaps">("segments");
    const [, setStreamIndexes] = createSignal<number[]>([]);
    const [, setCutStrategy] = createSignal(defaultSettings.cutStrategy);
    const [, setDestinationId] = createSignal("download");
    const [, setFilenameTemplate] = createSignal(defaultSettings.filenameTemplate);
    let editorVersion = 0;
    const controller = createProjectsController({
      api,
      queryClient: new QueryClient(),
      selected,
      projectId,
      setProjectId,
      projectName,
      setProjectName,
      revision,
      setRevision,
      dirty,
      setDirty,
      editorVersion: () => editorVersion,
      projectItems,
      setProjectItems,
      setSelectedExportItems,
      setActiveItemId,
      setSelected,
      setTimeline,
      setPreviewCenterMs: () => undefined,
      setMedia,
      setRecent,
      settings: () => defaultSettings,
      setMuted,
      setExportMode,
      setExportSelection,
      setStreamIndexes,
      setCutStrategy,
      setDestinationId,
      setFilenameTemplate,
      editableItems: projectItems,
      clearDetectionContext: () => undefined,
      setDiagnostics: () => undefined,
      setStatus: () => "",
    });

    const loading = controller.loadProject("p_loaded");
    editorVersion++;
    setProjectName("Unsaved edit");
    resolveProject(
      Response.json({
        id: "p_loaded",
        revision: 1,
        updatedAt: "2026-01-01T00:00:00Z",
        schemaVersion: 2,
        name: "Loaded project",
        items: [
          {
            id: "i_loaded",
            mediaId: media.id,
            segments: [],
            editorState: { playheadMs: 0, zoom: 1, muted: false },
            exportOptions: {
              mode: "merge",
              selection: "segments",
              cutStrategy: "stream_copy_preferred",
              container: "mkv",
            },
          },
        ],
      }),
    );
    await loading;

    expect(projectId()).toBe("p_current");
    expect(projectName()).toBe("Unsaved edit");
    expect(knownMedia()).toEqual([]);
    expect(timeline().present.segments).toEqual([]);
    controller.dispose();
  });
});
