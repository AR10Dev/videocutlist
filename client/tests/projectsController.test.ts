import { Effect } from "effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import type { ApiClient, NativeMediaApiClient } from "../src/api";
import { createServerState, readServerAtom } from "../src/features/app/server";
import { createTimelineHistory } from "../src/features/editor/timeline";
import { createProjectsController } from "../src/features/projects/controller";
import type { EditableProjectItem } from "../src/features/projects/model";
import { defaultSettings } from "../src/features/settings/model";
import type { components } from "../src/generated/api";

const media: components["schemas"]["Media"] = {
  id: "m_" + "a".repeat(43),
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
  it("reads saved-project pages through the generated project API", async () => {
    const originalFetch = globalThis.fetch;
    let requestedURL = "";
    globalThis.fetch = async (input) => {
      requestedURL = String(input);
      return Response.json({
        items: [
          {
            id: "p_savedproject0001",
            name: "Saved project",
            revision: 3,
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
        nextCursor: "opaque-next-page",
      });
    };
    const api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest"> = {
      url: (path) => path,
      request: () => Promise.reject(new Error("Unexpected legacy request")),
      assetRequest: () => Promise.reject(new Error("Unexpected asset request")),
      mediaRequest: () => Promise.reject(new Error("Unexpected media attachment request")),
    };
    const registry = AtomRegistry.make();
    const server = createServerState(api, registry, {
      serverBaseUrl: "http://localhost",
      authentication: { type: "none" },
    });
    try {
      const resource = server.projectPage({ limit: 50, cursor: "opaque-cursor" });
      const page = await Effect.runPromise(readServerAtom(server, resource));
      expect(new URL(requestedURL).pathname).toBe("/api/v2/projects");
      expect(new URL(requestedURL).searchParams.get("cursor")).toBe("opaque-cursor");
      expect(page.items[0]?.name).toBe("Saved project");
      expect(page.nextCursor).toBe("opaque-next-page");
    } finally {
      registry.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  it.each(["an edit", "a media switch"])(
    "does not apply a delayed load after %s",
    async (change) => {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: memoryStorage(),
      });
      let resolveProject!: (response: Response) => void;
      const projectResponse = new Promise<Response>((resolve) => {
        resolveProject = resolve;
      });
      const generatedRequests: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        const url = String(input);
        generatedRequests.push(url);
        return url.includes("/projects/") ? projectResponse : Response.json(media);
      };
      const request: ApiClient["request"] = (path) =>
        path.startsWith("projects/") ? projectResponse : Promise.resolve(Response.json(media));
      const api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest"> = {
        url: (path) => path,
        request,
        assetRequest: () => Promise.resolve(Response.json({})),
        mediaRequest: () => Promise.reject(new Error("Unexpected media attachment request")),
      };
      const [selected, setSelected] = createSignal<components["schemas"]["Media"]>();
      const [projectId, setProjectId] = createSignal("p_currentproject");
      const [projectName, setProjectName] = createSignal("Editing");
      const [revision, setRevision] = createSignal(0);
      const [dirty, setDirty] = createSignal(false);
      const [projectItems, setProjectItems] = createSignal<EditableProjectItem[]>([]);
      const [, setSelectedExportItems] = createSignal<string[]>([]);
      const [, setActiveItemId] = createSignal<string>();
      const [timeline, setTimeline] = createSignal(
        createTimelineHistory({ playheadMs: 0, inMs: 0, outMs: 0, segments: [], zoom: 1 }),
      );
      const [, setRecent] = createSignal<{ id: string; label: string; lastOpened: number }[]>([]);
      const [, setMuted] = createSignal(false);
      const [, setExportMode] = createSignal<"merge" | "separate">("merge");
      const [, setExportSelection] = createSignal<"segments" | "gaps">("segments");
      const [, setStreamIndexes] = createSignal<number[]>([]);
      const [, setCutStrategy] = createSignal(defaultSettings.cutStrategy);
      const [, setExportContainer] = createSignal<"mkv" | "mp4" | "mov">("mkv");
      const [, setDestinationId] = createSignal("download");
      const [, setFilenameTemplate] = createSignal(defaultSettings.filenameTemplate);
      let editorVersion = 0;
      let editorContext = 0;
      const registry = AtomRegistry.make();
      const controller = createProjectsController({
        server: createServerState(api, registry, {
          serverBaseUrl: "http://localhost",
          authentication: { type: "none" },
        }),
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
        contextKey: () => String(editorContext),
        projectItems,
        setProjectItems,
        setSelectedExportItems,
        setActiveItemId,
        setSelected,
        setTimeline,
        setPreviewCenterMs: () => undefined,
        setRecent,
        settings: () => defaultSettings,
        setMuted,
        setExportMode,
        setExportSelection,
        setStreamIndexes,
        setCutStrategy,
        setExportContainer,
        setDestinationId,
        setFilenameTemplate,
        editableItems: projectItems,
        clearDetectionContext: () => undefined,
        setDiagnostics: () => undefined,
        setStatus: () => "",
      });

      const loading = controller.loadProject("p_loadedproject");
      if (change === "an edit") {
        editorVersion++;
        setProjectName("Unsaved edit");
      } else {
        editorContext++;
        setSelected({ ...media, id: "m_" + "b".repeat(43), name: "new.mp4" });
      }
      resolveProject(
        Response.json({
          id: "p_loadedproject",
          revision: 1,
          updatedAt: "2026-01-01T00:00:00Z",
          schemaVersion: 2,
          name: "Loaded project",
          items: [
            {
              id: "i_loadedproject",
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
      globalThis.fetch = originalFetch;

      expect(
        generatedRequests.some((url) => url.endsWith("/api/v2/projects/p_loadedproject")),
      ).toBe(true);
      expect(projectId()).toBe("p_currentproject");
      expect(projectName()).toBe(change === "an edit" ? "Unsaved edit" : "Editing");
      if (change === "a media switch") expect(selected()?.id).toBe("m_" + "b".repeat(43));
      expect(timeline().present.segments).toEqual([]);
      controller.dispose();
      registry.dispose();
    },
  );

  it("keeps conflict choices after a failed remote reload", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: memoryStorage(),
    });
    const item: EditableProjectItem = {
      id: "i_conflictload000000000000",
      media,
      timeline: createTimelineHistory({
        playheadMs: 100,
        segments: [{ id: "s_conflict", startMs: 100, endMs: 300 }],
        zoom: 1,
      }),
      muted: false,
      exportOptions: {
        mode: "merge",
        selection: "segments",
        cutStrategy: "stream_copy_preferred",
        container: "mkv",
      },
    };
    const remoteProject: components["schemas"]["Project"] = {
      id: "p_conflict-load1",
      revision: 2,
      updatedAt: "2026-01-01T00:00:00Z",
      schemaVersion: 2,
      name: "Remote project",
      items: [
        {
          id: item.id,
          mediaId: media.id,
          segments: [{ startMs: 200, endMs: 400 }],
          exportOptions: {},
        },
      ],
    };
    let reloadFailed = true;
    const originalFetch = globalThis.fetch;
    const generatedRequests: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (init?.method !== "PUT") generatedRequests.push(url);
      if (url.endsWith(`/api/v2/projects/p_conflict-load1`) && init?.method === "PUT")
        return Response.json(
          {
            error: {
              code: "revision_conflict",
              message: "Project changed",
              requestId: "r-conflict",
            },
          },
          { status: 409 },
        );
      if (url.endsWith(`/api/v2/projects/p_conflict-load1`))
        return reloadFailed ? new Response(null, { status: 503 }) : Response.json(remoteProject);
      if (url.endsWith(`/api/v2/media/${media.id}`)) return Response.json(media);
      return new Response(null, { status: 404 });
    };
    const api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest"> = {
      url: (path) => path,
      request: (path, init) => {
        if (path === "projects/p_conflict-load1" && init?.method === "PUT")
          return Promise.resolve(
            Response.json(
              {
                error: {
                  code: "revision_conflict",
                  message: "Project changed",
                  requestId: "r-conflict",
                },
              },
              { status: 409 },
            ),
          );
        if (path === "projects/p_conflict-load1")
          return Promise.resolve(
            reloadFailed ? new Response(null, { status: 503 }) : Response.json(remoteProject),
          );
        if (path === `media/${media.id}`) return Promise.resolve(Response.json(media));
        return Promise.reject(new Error(`Unexpected request: ${path}`));
      },
      assetRequest: () => Promise.resolve(Response.json({})),
      mediaRequest: () => Promise.reject(new Error("Unexpected media attachment request")),
    };
    const [selected, setSelected] = createSignal<components["schemas"]["Media"] | undefined>(media);
    const [projectId, setProjectId] = createSignal("p_conflict-load1");
    const [projectName, setProjectName] = createSignal("Local project");
    const [revision, setRevision] = createSignal(1);
    const [dirty, setDirty] = createSignal(true);
    const [projectItems, setProjectItems] = createSignal([item]);
    const [, setSelectedExportItems] = createSignal<string[]>([]);
    const [, setActiveItemId] = createSignal<string | undefined>(item.id);
    const [timeline, setTimeline] = createSignal(item.timeline);
    const [, setRecent] = createSignal<{ id: string; label: string; lastOpened: number }[]>([]);
    const [, setMuted] = createSignal(false);
    const [, setExportMode] = createSignal<"merge" | "separate">("merge");
    const [, setExportSelection] = createSignal<"segments" | "gaps">("segments");
    const [, setStreamIndexes] = createSignal<number[]>([]);
    const [, setCutStrategy] = createSignal(defaultSettings.cutStrategy);
    const [, setExportContainer] = createSignal<"mkv" | "mp4" | "mov">("mkv");
    const [, setDestinationId] = createSignal("download");
    const [, setFilenameTemplate] = createSignal(defaultSettings.filenameTemplate);
    const registry = AtomRegistry.make();
    let lastStatus = "";
    const controller = createProjectsController({
      server: createServerState(api, registry, {
        serverBaseUrl: "http://localhost",
        authentication: { type: "none" },
      }),
      selected,
      projectId,
      setProjectId,
      projectName,
      setProjectName,
      revision,
      setRevision,
      dirty,
      setDirty,
      editorVersion: () => 1,
      contextKey: () => `${projectId()}::${selected()?.id ?? ""}`,
      projectItems,
      setProjectItems,
      setSelectedExportItems,
      setActiveItemId,
      setSelected,
      setTimeline,
      setPreviewCenterMs: () => undefined,
      setRecent,
      settings: () => defaultSettings,
      setMuted,
      setExportMode,
      setExportSelection,
      setStreamIndexes,
      setCutStrategy,
      setExportContainer,
      setDestinationId,
      setFilenameTemplate,
      editableItems: () => projectItems(),
      clearDetectionContext: () => undefined,
      setDiagnostics: () => undefined,
      setStatus: (value) => {
        lastStatus = typeof value === "function" ? value(lastStatus) : value;
        return lastStatus;
      },
    });

    await controller.saveProject();
    expect(controller.saveConflict()).toBe(true);
    await controller.reloadRemoteProject();
    expect(controller.saveConflict()).toBe(true);

    reloadFailed = false;
    await controller.reloadRemoteProject();
    globalThis.fetch = originalFetch;
    expect(
      generatedRequests.filter((url) => url.endsWith("/api/v2/projects/p_conflict-load1")),
    ).toHaveLength(2);
    expect(lastStatus).toBe("Project loaded.");
    expect(controller.saveConflict()).toBe(false);
    expect(projectName()).toBe("Remote project");
    expect(timeline().present.segments[0]?.startMs).toBe(200);
    controller.dispose();
    registry.dispose();
  });

  it("debounces saves, keeps recovery, and ignores recents storage failures", async () => {
    const storage = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    const item: EditableProjectItem = {
      id: "i_autosave1234567890123456",
      media,
      timeline: createTimelineHistory({
        playheadMs: 100,
        segments: [{ id: "s_saved", startMs: 100, endMs: 300, label: "Segment 001" }],
        zoom: 1,
      }),
      muted: false,
      exportOptions: {
        mode: "separate",
        selection: "segments",
        cutStrategy: "stream_copy_preferred",
        container: "mkv",
      },
    };
    const [selected] = createSignal<components["schemas"]["Media"]>(media);
    const [projectId, setProjectId] = createSignal("p_autosave123456");
    const [projectName, setProjectName] = createSignal("Editing");
    const [revision, setRevision] = createSignal(0);
    const [dirty, setDirty] = createSignal(true);
    const [projectItems, setProjectItems] = createSignal([item]);
    const [, setSelectedExportItems] = createSignal<string[]>([]);
    const [, setActiveItemId] = createSignal<string | undefined>(item.id);
    const [, setTimeline] = createSignal(item.timeline);
    const [, setRecent] = createSignal<{ id: string; label: string; lastOpened: number }[]>([]);
    const [, setMuted] = createSignal(false);
    const [, setExportMode] = createSignal<"merge" | "separate">("separate");
    const [, setExportSelection] = createSignal<"segments" | "gaps">("segments");
    const [, setStreamIndexes] = createSignal<number[]>([]);
    const [, setCutStrategy] = createSignal(defaultSettings.cutStrategy);
    const [, setDestinationId] = createSignal("download");
    const [, setFilenameTemplate] = createSignal(defaultSettings.filenameTemplate);
    let editorVersion = 1;
    const [, setExportContainer] = createSignal<"mkv" | "mp4" | "mov">("mkv");
    let requests = 0;
    let delayedBody: Record<string, unknown> = {};
    const submitted: Array<{ revision: number; name: string }> = [];
    let signalFirstSave!: () => void;
    const firstSaveStarted = new Promise<void>((resolve) => {
      signalFirstSave = resolve;
    });
    let resolveDelayedSave!: (response: Response) => void;
    let signalDelayedSave!: () => void;
    const delayedSaveStarted = new Promise<void>((resolve) => {
      signalDelayedSave = resolve;
    });
    let signalContextSave!: () => void;
    const contextSaveStarted = new Promise<void>((resolve) => {
      signalContextSave = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/projects/p_autosave123456") && init?.method === "PUT") {
        requests += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown> & {
          revision: number;
          name: string;
        };
        submitted.push({ revision: body.revision, name: body.name });
        if (requests === 1) signalFirstSave();
        const response = Response.json({
          ...body,
          id: projectId(),
          revision: requests,
          updatedAt: "2026-01-01T00:00:00Z",
        });
        if (requests === 4)
          return Response.json(
            {
              error: {
                code: "internal_error",
                message: "Save outcome is uncertain.",
                requestId: "r-uncertain",
              },
            },
            { status: 500 },
          );
        if (requests === 2 || requests === 5) {
          delayedBody = body;
          if (requests === 2) signalDelayedSave();
          else signalContextSave();
          return new Promise<Response>((resolve) => {
            resolveDelayedSave = resolve;
          });
        }
        return response;
      }
      return Response.json(media);
    };
    const api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest"> = {
      url: (path) => path,
      request: () => Promise.reject(new Error("Unexpected legacy request")),
      assetRequest: () => Promise.resolve(Response.json({})),
      mediaRequest: () => Promise.reject(new Error("Unexpected media attachment request")),
    };
    const registry = AtomRegistry.make();
    const configuration = {
      serverBaseUrl: "http://localhost",
      authentication: { type: "none" as const },
    };
    const controller = createProjectsController({
      server: createServerState(api, registry, configuration),
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
      contextKey: () => `${projectId()}::${selected()?.id ?? ""}`,
      projectItems,
      setProjectItems,
      setSelectedExportItems,
      setActiveItemId,
      setSelected: () => undefined,
      setTimeline,
      setPreviewCenterMs: () => undefined,
      setRecent,
      settings: () => defaultSettings,
      setMuted,
      setExportMode,
      setExportSelection,
      setStreamIndexes,
      setCutStrategy,
      setExportContainer,
      setDestinationId,
      setFilenameTemplate,
      editableItems: () => projectItems(),
      clearDetectionContext: () => undefined,
      setDiagnostics: () => undefined,
      setStatus: () => undefined,
    });
    controller.captureRecovery();
    expect(controller.recovery()?.items[0].mediaId).toBe(media.id);
    expect(JSON.stringify(controller.recovery())).not.toContain(media.name);
    const persistedSetItem = storage.setItem;
    storage.setItem = (key, value) => {
      if (key === "videocutlist.recent-projects.v1" || key === "videocutlist.active-project.v2")
        throw new Error("storage quota exceeded");
      persistedSetItem(key, value);
    };
    controller.scheduleAutosave();
    await firstSaveStarted;
    expect(requests).toBe(1);
    // An explicit save queues behind the autosave currently in flight.
    const saving = controller.saveProject();
    await delayedSaveStarted;
    expect(controller.saveError()).toBe("");
    expect(controller.recovery()).toBeUndefined();
    // A later edit waits for the in-flight PUT and uses its returned revision.
    setProjectName("Newer edit");
    editorVersion++;
    setDirty(true);
    controller.scheduleAutosave();
    expect(requests).toBe(2);
    resolveDelayedSave(
      Response.json({
        ...delayedBody,
        id: "p_autosave123456",
        revision: 2,
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    await saving;
    expect(submitted).toEqual([
      { revision: 0, name: "Editing" },
      { revision: 1, name: "Editing" },
      { revision: 2, name: "Newer edit" },
    ]);
    expect(controller.saveState()).toBe("saved");
    expect(dirty()).toBe(false);
    setProjectName("Uncertain edit");
    editorVersion++;
    setDirty(true);
    await controller.saveProject();
    expect(requests).toBe(4);
    expect(controller.saveState()).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(requests).toBe(4);
    // A late PUT response from the previous context must not overwrite the new project.
    const staleSave = controller.saveProject();
    await contextSaveStarted;
    setDirty(false);
    controller.newProject();
    const newID = projectId();
    resolveDelayedSave(
      Response.json({
        ...delayedBody,
        id: "p_autosave123456",
        revision: 4,
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    await staleSave;
    expect(projectId()).toBe(newID);
    expect(projectItems()).toEqual([]);
    expect(revision()).toBe(0);
    expect(controller.saveState()).toBe("unsaved");
    expect(localStorage.getItem("videocutlist.active-project.v2")).toBeNull();
    controller.dispose();
    registry.dispose();
    globalThis.fetch = originalFetch;
    void setProjectName;
    void setRevision;
    void setTimeline;
    void editorVersion;
  });
});
