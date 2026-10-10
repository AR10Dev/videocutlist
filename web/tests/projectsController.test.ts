import type * as EffectApiTypes from "../src/generated/effect-api";
import { Effect, Layer } from "effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { createPersistencePolicy } from "../src/features/app/persistence";
import {
  recoveryKey,
  rememberedProjectKey,
  recentProjectsKey,
} from "../src/features/projects/lifecycle";
import * as Atom from "effect/reactivity/Atom";
import { createSignal, type Setter } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, NativeMediaApiClient } from "../src/api";
import { createServerState, readServerAtom } from "../src/features/app/server";
import { createTimelineHistory } from "../src/features/editor/timeline";
import { createProjectsTestController as createProjectsController } from "./projectCommands";
import type { EditableProjectItem } from "../src/features/projects/model";
import { defaultSettings } from "../src/features/settings/model";
import { memoryStorage } from "./memoryStorage";

const media: EffectApiTypes.Media = {
  id: "m_" + "a".repeat(43),
  name: "loaded.mp4",
  durationMs: 10_000,
  sizeBytes: 1,
  container: "mp4",
  streams: {},
  etag: "v1",
};

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

  it.each([
    "an edit",
    "a media switch",
    "a normal project restore",
    "a superseding load",
    "invalid restored segments",
    "imported document",
    "denied reset",
    "confirmed reset",
    "failed media restoration",
    "second media restoration fails",
  ])("loads media through the generated resource and respects %s", async (change) => {
    const originalFetch = globalThis.fetch;
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: memoryStorage(),
    });
    let resolveProject!: (response: Response) => void;
    let projectResolved = false;
    const projectResponse = new Promise<Response>((resolve) => {
      resolveProject = (response) => {
        projectResolved = true;
        resolve(response);
      };
    });
    let newerProject: EffectApiTypes.Project | undefined;
    let signalProjectStarted!: () => void;
    const projectStarted = new Promise<void>((resolve) => {
      signalProjectStarted = resolve;
    });
    globalThis.fetch = async (input) => {
      if (String(input).includes("/projects/p_newerproject")) return Response.json(newerProject);
      if (String(input).includes("/projects/")) {
        signalProjectStarted();
        return projectResponse;
      }
      return Response.json(media);
    };
    const request: ApiClient["request"] = (path) =>
      path.startsWith("projects/") ? projectResponse : Promise.resolve(Response.json(media));
    const api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest"> = {
      url: (path) => path,
      request,
      assetRequest: () => Promise.resolve(Response.json({})),
      mediaRequest: () => Promise.reject(new Error("Unexpected media attachment request")),
    };
    const [selected, setSelected] = createSignal<EffectApiTypes.Media>();
    const [projectId, setProjectId] = createSignal("p_currentproject");
    const [projectName, setProjectName] = createSignal("Editing");
    const [revision, setRevision] = createSignal(0);
    const [dirty, setDirty] = createSignal(false);
    const [projectItems, setProjectItems] = createSignal<EditableProjectItem[]>([]);
    const [, setSelectedExportItems] = createSignal<string[]>([]);
    const [activeItemId, setActiveItemId] = createSignal<string>();
    const [timeline, replaceTimeline] = createSignal(
      createTimelineHistory({ playheadMs: 0, inMs: 0, outMs: 0, segments: [], zoom: 1 }),
    );
    const [, setMuted] = createSignal(false);
    let editorVersion = 0;
    let editorContext = 0;
    let status = "";
    const registry = AtomRegistry.make();
    const server = createServerState(api, registry, {
      serverBaseUrl: "http://localhost",
      authentication: { type: "none" },
    });
    if (change === "failed media restoration")
      server.media = () => server.runtime.atom(Effect.fail(new Error("private backend detail")));
    if (change === "second media restoration fails") {
      const metadata = server.media;
      server.media = (id) =>
        id === media.id
          ? metadata(id)
          : server.runtime.atom(Effect.fail(new Error("private backend detail")));
    }
    let detectionCleared = 0;
    let diagnosticsCleared = 0;
    const controller = createProjectsController({
      activeItemId,
      server,
      selected,
      projectId,
      projectName,
      revision,
      setRevision,
      dirty,
      setDirty,
      editorVersion: () => editorVersion,
      contextKey: () => String(editorContext),
      projectItems,
      setProjectItems,
      setSelectedExportItems,
      replaceContext: (context) => {
        setProjectId(context.projectId);
        setProjectName(context.projectName);
        setRevision(context.revision);
        setDirty(context.dirty);
        setActiveItemId(context.activeItemId);
        setSelected(context.selected);
      },
      replaceTimeline,
      setPreviewCenterMs: () => undefined,
      settings: () => defaultSettings,
      setMuted,
      editableItems: projectItems,
      clearDetectionContext: () => {
        detectionCleared++;
      },
      setDiagnostics: () => {
        diagnosticsCleared++;
      },
      setStatus: (value) => {
        status = typeof value === "function" ? value(status) : value;
        return status;
      },
    });

    const failedRestoration =
      change === "invalid restored segments" ||
      change === "failed media restoration" ||
      change === "second media restoration fails";
    if (failedRestoration) {
      replaceTimeline(
        createTimelineHistory({
          playheadMs: 100,
          zoom: 2,
          inMs: 500,
          segments: [{ id: "s_existing", startMs: 0, endMs: 100 }],
        }),
      );
      setProjectItems([
        { id: "i_existing", media, timeline: timeline(), muted: true, exportOptions: {} },
      ]);
      setSelected(media);
      setActiveItemId("i_existing");
    }
    const originalTimeline = timeline();
    const originalItems = projectItems();
    let loading: Promise<void> | undefined;
    try {
      loading = controller.loadProject("p_loadedproject");
      if (change === "an edit") {
        editorVersion++;
        setProjectName("Unsaved edit");
      } else if (change === "a media switch") {
        editorContext++;
        setSelected({ ...media, id: "m_" + "b".repeat(43), name: "new.mp4" });
      }
      let document: EffectApiTypes.Project = {
        id: "p_loadedproject",
        revision: 1,
        updatedAt: "2026-01-01T00:00:00Z",
        schemaVersion: 2,
        name: "Loaded project",
        items: [
          {
            id: `i_${"l".repeat(24)}`,
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
      };
      if (change === "invalid restored segments")
        document = {
          ...document,
          items: [
            {
              ...document.items[0],
              segments: [{ id: "s_invalid", startMs: 0, endMs: media.durationMs + 1 }],
            },
          ],
        };
      if (change === "second media restoration fails")
        document = {
          ...document,
          items: [
            ...document.items,
            { ...document.items[0], id: `i_${"x".repeat(24)}`, mediaId: "m_" + "b".repeat(43) },
          ],
        };
      if (change === "a superseding load") {
        // B completes while A's fetch ignores interruption and resolves late below.
        await projectStarted;
        expect(controller.loadPending()).toBe(true);
        newerProject = { ...document, id: "p_newerproject", name: "Newer project" };
        await controller.loadProject("p_newerproject", undefined, true);
      }
      if (change === "imported document") {
        await controller.loadProject(document.id, document, true);
      }
      if (change === "denied reset") {
        setDirty(true);
        controller.newProject(false);
        expect(projectId()).toBe("p_currentproject");
        expect(detectionCleared).toBe(0);
        expect(diagnosticsCleared).toBe(0);
      }
      if (change === "confirmed reset") {
        setDirty(true);
        controller.newProject(true);
        expect(projectId()).not.toBe("p_currentproject");
        expect(timeline()).toEqual(createTimelineHistory({ playheadMs: 0, segments: [], zoom: 1 }));
        expect(activeItemId()).toBeUndefined();
        expect(projectItems()).toEqual([]);
        expect(dirty()).toBe(false);
        expect(detectionCleared).toBe(1);
        expect(diagnosticsCleared).toBe(1);
      }
      resolveProject(Response.json(document));
      await loading;

      if (change === "a superseding load") {
        expect(projectId()).toBe("p_newerproject");
        expect(projectName()).toBe("Newer project");
        expect(dirty()).toBe(false);
      } else if (change === "imported document") {
        expect(projectId()).toBe(document.id);
        expect(dirty()).toBe(true);
        expect(controller.saveState()).toBe("unsaved");
      } else if (change === "confirmed reset") {
        expect(controller.saveState()).toBe("unsaved");
      } else if (failedRestoration) {
        expect(projectId()).toBe("p_currentproject");
        expect(projectItems()).toBe(originalItems);
        expect(timeline()).toBe(originalTimeline);
        expect(activeItemId()).toBe("i_existing");
        expect(selected()).toBe(media);
        expect(controller.loadError()?.message).toBe(
          "Project could not be loaded. Check its media and try again.",
        );
        expect(status).not.toContain("private backend detail");
        expect(detectionCleared).toBe(0);
        expect(diagnosticsCleared).toBe(0);
      } else {
        expect(projectId(), status).toBe(
          change === "a normal project restore" || change === "denied reset"
            ? document.id
            : "p_currentproject",
        );
        if (change === "a normal project restore") {
          expect(revision()).toBe(1);
          expect(dirty()).toBe(false);
          expect(controller.saveState()).toBe("saved");
          expect(controller.loadPending()).toBe(false);
          expect(controller.loadResult()._tag).toBe("Success");
        }
        if (change === "an edit") expect(projectName()).toBe("Unsaved edit");
        if (change === "a media switch") expect(selected()?.id).toBe("m_" + "b".repeat(43));
      }
      if (!failedRestoration) expect(timeline().present.segments).toEqual([]);
    } finally {
      if (!projectResolved) resolveProject(new Response(null, { status: 503 }));
      await loading?.catch(() => undefined);
      controller.dispose();
      registry.dispose();
      globalThis.fetch = originalFetch;
      if (originalLocalStorage)
        Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("keeps conflict choices after a failed remote reload", async () => {
    let reloadFailed = true;
    let reloads = 0;
    await withSaveWorkspace(
      async ({ controller, state, requests, nextRequest }) => {
        const started = nextRequest();
        const saving = controller.saveProject();
        await started;
        requests[0].complete(409);
        await saving;
        expect(controller.saveConflict()).toBe(true);

        await controller.reloadRemoteProject();
        expect(controller.saveConflict()).toBe(true);
        reloadFailed = false;
        await controller.reloadRemoteProject();
        expect(reloads).toBe(2);
        expect(state().status).toBe("Project loaded.");
        expect(controller.saveConflict()).toBe(false);
        expect(state().name).toBe("Remote project");
        expect(state().items[0].timeline.present.segments[0]?.startMs).toBe(200);
      },
      {
        projectResponse: () => {
          reloads++;
          return reloadFailed
            ? new Response(null, { status: 503 })
            : Response.json({
                id: "p_saveworkflow01",
                revision: 2,
                updatedAt: "2026-01-01T00:00:00Z",
                schemaVersion: 2,
                name: "Remote project",
                items: [
                  {
                    id: `i_${"s".repeat(24)}`,
                    mediaId: media.id,
                    segments: [{ startMs: 200, endMs: 400 }],
                    exportOptions: {},
                  },
                ],
              } satisfies EffectApiTypes.Project);
        },
      },
    );
  });

  it("debounces autosave and leaves uncertain failures waiting for explicit retry", async () => {
    await withSaveWorkspace(async ({ controller, state, requests, nextRequest, storage }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      controller.captureRecovery();
      expect(controller.recovery()?.items[0].mediaId).toBe(media.id);
      expect(JSON.stringify(controller.recovery())).not.toContain(media.name);
      const setItem = storage.setItem;
      storage.setItem = (key, value) => {
        if (key === recentProjectsKey || key === rememberedProjectKey)
          throw new Error("storage quota exceeded");
        setItem(key, value);
      };
      const started = nextRequest();
      controller.scheduleAutosave();
      await flushPersistence();
      expect(requests).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(500);
      controller.scheduleAutosave();
      await flushPersistence();
      await vi.advanceTimersByTimeAsync(749);
      expect(requests).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await started;
      requests[0].complete();
      await vi.waitFor(() => expect(controller.saveState()).toBe("saved"));
      expect(state().dirty).toBe(false);
      expect(controller.recovery()).toBeUndefined();

      const retryStarted = nextRequest();
      const saving = controller.saveProject();
      await retryStarted;
      requests[1].complete(500, "internal_error");
      await saving;
      expect(controller.saveState()).toBe("failed");
      await vi.advanceTimersByTimeAsync(2000);
      expect(requests).toHaveLength(2);
    });
  });
});

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

type SaveRequest = {
  id: string;
  payload: EffectApiTypes.ProjectInput;
  signal: AbortSignal | null | undefined;
  complete: (status?: number, code?: string) => void;
};

type SaveWorkspace = {
  controller: ReturnType<typeof createProjectsController>;
  state: () => SaveWorkspaceState;
  edit: (changes: Partial<SaveWorkspaceState>) => void;
  switchMedia: () => void;
  storage: Storage;
  requests: SaveRequest[];
  reads: string[];
  nextRequest: () => Promise<void>;
};

async function withSaveWorkspace(
  exercise: (workspace: SaveWorkspace) => Promise<void>,
  options?: {
    storage?: Storage;
    stored?: Record<string, string>;
    read?: (key: string) => Effect.Effect<string | undefined, KeyValueStore.KeyValueStoreError>;
    failWrites?: boolean;
    clean?: boolean;
    projectResponse?: () => Response;
  },
) {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = options?.storage ?? memoryStorage();
  for (const [key, value] of Object.entries(options?.stored ?? {})) storage.setItem(key, value);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  const registry = AtomRegistry.make({ defaultIdleTTL: 0 });
  const initial: SaveWorkspaceState = {
    id: "p_saveworkflow01",
    name: "Local edits",
    revision: 1,
    dirty: !options?.clean,
    editorVersion: 1,
    selected: media,
    status: "Editing",
    items: [
      {
        id: `i_${"s".repeat(24)}`,
        media,
        timeline: createTimelineHistory({
          playheadMs: 0,
          segments: [{ id: "s_cut", startMs: 100, endMs: 300 }],
          zoom: 1,
        }),
        muted: false,
        exportOptions: {},
      },
    ],
  };
  const stateAtom = Atom.keepAlive(Atom.make(initial));
  const state = () => registry.get(stateAtom);
  const field = <K extends "revision" | "dirty" | "items" | "status">(key: K) =>
    ((
      input: SaveWorkspaceState[K] | ((previous: SaveWorkspaceState[K]) => SaveWorkspaceState[K]),
    ) => {
      const value = typeof input === "function" ? input(state()[key]) : input;
      registry.update(stateAtom, (state) => ({ ...state, [key]: value }));
      return value;
    }) as Setter<SaveWorkspaceState[K]>;
  let started = deferred<void>();
  const requests: SaveRequest[] = [];
  const reads: string[] = [];
  globalThis.fetch = (input, init) => {
    if (init?.method !== "PUT") {
      reads.push(String(input));
      if (options?.projectResponse && String(input).includes("/projects/"))
        return Promise.resolve(options.projectResponse());
      return Promise.resolve(
        Response.json(
          String(input).includes("/projects/")
            ? {
                id: "p_remembered00001",
                name: storedRecovery.name,
                revision: storedRecovery.revision,
                schemaVersion: 2,
                items: storedRecovery.items,
                updatedAt: "2026-01-01T00:00:00Z",
              }
            : media,
        ),
      );
    }
    const response = deferred<Response>();
    const id = new URL(String(input)).pathname.split("/").at(-1)!;
    const payload = JSON.parse(String(init.body)) as EffectApiTypes.ProjectInput;
    requests.push({
      id,
      payload,
      signal: init.signal,
      complete: (status = 200, code = "revision_conflict") => {
        response.resolve(
          status === 200
            ? Response.json({
                ...payload,
                id,
                revision: payload.revision + 1,
                updatedAt: "2026-01-01T00:00:00Z",
              })
            : Response.json(
                { error: { code, message: "private server detail", requestId: "r-save" } },
                { status },
              ),
        );
      },
    });
    started.resolve();
    started = deferred<void>();
    return response.promise;
  };
  const api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest"> = {
    url: (path) => path,
    request: () => Promise.reject(new Error("Unexpected legacy request")),
    assetRequest: () => Promise.reject(new Error("Unexpected asset request")),
    mediaRequest: () => Promise.reject(new Error("Unexpected media request")),
  };
  const server = createServerState(api, registry, {
    serverBaseUrl: "http://localhost",
    authentication: { type: "none" },
  });
  const testStore = KeyValueStore.makeStringOnly({
    get: options?.read ?? ((key) => Effect.sync(() => storage.getItem(key) ?? undefined)),
    set: (key, value) =>
      options?.failWrites
        ? Effect.fail(
            new KeyValueStore.KeyValueStoreError({ method: "set", key, message: "denied" }),
          )
        : Effect.sync(() => storage.setItem(key, value)),
    remove: (key) =>
      options?.failWrites
        ? Effect.fail(
            new KeyValueStore.KeyValueStoreError({ method: "remove", key, message: "denied" }),
          )
        : Effect.sync(() => storage.removeItem(key)),
    clear: Effect.void,
    size: Effect.succeed(0),
  });
  const runtime = Atom.runtime(Layer.succeed(KeyValueStore.KeyValueStore, testStore));
  const controller = createProjectsController({
    server: options
      ? { ...server, runtime, persistence: createPersistencePolicy(runtime, registry) }
      : server,
    selected: () => state().selected,
    activeItemId: () => state().items[0]?.id,
    projectId: () => state().id,
    projectName: () => state().name,
    revision: () => state().revision,
    setRevision: field("revision"),
    dirty: () => state().dirty,
    setDirty: field("dirty"),
    editorVersion: () => state().editorVersion,
    contextKey: () => `${state().id}::${state().selected?.id ?? ""}`,
    projectItems: () => state().items,
    setProjectItems: field("items"),
    editableItems: () => state().items,
    setSelectedExportItems: () => [],
    replaceContext: (context) =>
      registry.update(stateAtom, (state) => ({
        ...state,
        id: context.projectId,
        name: context.projectName,
        revision: context.revision,
        dirty: context.dirty,
        selected: context.selected,
      })),
    replaceTimeline: () => undefined,
    setPreviewCenterMs: () => undefined,
    settings: () => defaultSettings,
    setMuted: () => false,
    clearDetectionContext: () => undefined,
    setDiagnostics: () => undefined,
    setStatus: field("status"),
  });
  try {
    await exercise({
      controller,
      state,
      storage,
      requests,
      reads,
      nextRequest: () => started.promise,
      edit: (changes) =>
        registry.update(stateAtom, (state) => ({
          ...state,
          ...changes,
          editorVersion: state.editorVersion + 1,
          dirty: true,
        })),
      switchMedia: () =>
        registry.update(stateAtom, (state) => ({
          ...state,
          selected: { ...media, id: `m_${"b".repeat(43)}` },
        })),
    });
  } finally {
    controller.dispose();
    registry.dispose();
    requests.forEach((request) => request.complete());
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    vi.useRealTimers();
  }
}

type SaveWorkspaceState = {
  id: string;
  name: string;
  revision: number;
  dirty: boolean;
  editorVersion: number;
  selected: EffectApiTypes.Media | undefined;
  status: string;
  items: EditableProjectItem[];
};

describe("workspace save command", () => {
  it("coalesces explicit and automatic requests and never replaces in-flight edits", async () => {
    await withSaveWorkspace(async ({ controller, state, edit, requests, nextRequest, storage }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const firstStarted = nextRequest();
      const saving = controller.saveProject();
      await firstStarted;
      expect(controller.saveState()).toBe("saving");
      expect(controller.saveResult().waiting).toBe(true);
      const items = state().items.map((item) => ({
        ...item,
        timeline: createTimelineHistory({
          playheadMs: 0,
          zoom: 1,
          segments: [{ id: "s_new", startMs: 500, endMs: 700 }],
        }),
      }));
      edit({ name: "Newer edits", items });
      controller.scheduleAutosave();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(750);
      const explicit = controller.saveProject();
      const coalesced = controller.saveProject();
      expect(requests).toHaveLength(1);
      expect(requests[0].payload.name).toBe("Local edits");
      expect(requests[0].payload.items[0].segments[0].startMs).toBe(100);
      const secondStarted = nextRequest();
      requests[0].complete();
      await secondStarted;
      expect(requests).toHaveLength(2);
      expect(state().revision).toBe(2);
      expect(state().dirty).toBe(true);
      expect(state().items).toBe(items);
      expect(controller.recovery()?.name).toBe("Newer edits");
      expect(storage.getItem("videocutlist.project-recovery.v1")).not.toBeNull();
      expect(requests[1].payload.revision).toBe(2);
      expect(requests[1].payload.name).toBe("Newer edits");
      expect(controller.saveState()).toBe("saving");
      requests[1].complete();
      const outcomes = await Promise.all([saving, explicit, coalesced]);
      expect(outcomes.map((project) => project?.revision)).toEqual([3, 3, 3]);
      expect(state().dirty).toBe(false);
      expect(state().items).toBe(items);
      expect(controller.recovery()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2000);
      expect(requests).toHaveLength(2);
      expect(controller.saveState()).toBe("saved");
    });
  });

  it("pauses autosave on conflict and saves local work under a new identity", async () => {
    await withSaveWorkspace(async ({ controller, state, edit, requests, nextRequest }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const started = nextRequest();
      const saving = controller.saveProject();
      await started;
      requests[0].complete(409);
      expect(await saving).toBeUndefined();
      expect(controller.saveResult()._tag).toBe("Failure");
      expect(controller.saveConflict()).toBe(true);
      expect(controller.saveError()).not.toContain("private server detail");
      edit({ name: "Keep local edits" });
      controller.scheduleAutosave();
      await vi.advanceTimersByTimeAsync(2000);
      await controller.retrySave();
      expect(requests).toHaveLength(1);
      expect(state().revision).toBe(1);
      expect(state().dirty).toBe(true);
      const newStarted = nextRequest();
      const savingNew = controller.saveAsNewProject();
      await newStarted;
      expect(requests[1].id).not.toBe(requests[0].id);
      expect(requests[1].payload.revision).toBe(0);
      expect(requests[1].payload.name).toBe("Keep local edits");
      requests[1].complete();
      expect((await savingNew)?.revision).toBe(1);
      expect(controller.saveConflict()).toBe(false);
      expect(state().dirty).toBe(false);
    });
  });

  it.each(["media switch", "new project", "disposal"])(
    "ignores a late mutation after %s",
    async (change) => {
      await withSaveWorkspace(
        async ({ controller, state, requests, nextRequest, switchMedia, storage }) => {
          const started = nextRequest();
          const saving = controller.saveProject();
          await started;
          if (change === "media switch") switchMedia();
          else if (change === "new project") controller.newProject(true);
          else controller.dispose();
          const before = state();
          requests[0].complete();
          expect(await saving).toBeUndefined();
          expect(state()).toBe(before);
          expect(storage.getItem("videocutlist.active-project.v2")).toBeNull();
          expect(state().status).not.toContain("Project saved");
          if (change !== "media switch") expect(requests[0].signal?.aborted).toBe(true);
        },
      );
    },
  );

  it.each(["blank name", "long name", "invalid segments"])(
    "rejects %s before HTTP with a composable failure",
    async (change) => {
      await withSaveWorkspace(async ({ controller, state, edit, requests }) => {
        if (change === "blank name") edit({ name: "  " });
        else if (change === "long name") edit({ name: "🎬".repeat(121) });
        else
          edit({
            items: state().items.map((item) => ({
              ...item,
              timeline: createTimelineHistory({
                playheadMs: 0,
                zoom: 1,
                segments: [{ startMs: 0, endMs: media.durationMs + 1 }],
              }),
            })),
          });
        const result = await Effect.runPromise(Effect.exit(controller.saveProjectEffect()));
        expect(result._tag).toBe("Failure");
        expect(requests).toEqual([]);
        expect(controller.saveState()).toBe("failed");
        expect(controller.saveError()).not.toBe("");
        expect(state().dirty).toBe(true);
        expect(state().revision).toBe(1);
      });
    },
  );
});

const storedRecovery = {
  version: 1 as const,
  projectId: "p_recovered000001",
  revision: 2,
  schemaVersion: 2 as const,
  name: "Recovered",
  savedAt: 1,
  items: [{ id: `i_${"r".repeat(24)}`, mediaId: media.id, segments: [], exportOptions: {} }],
};
const flushPersistence = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("workspace project persistence", () => {
  it("persists a Unicode-named project and a later ordinary project across reinitialization", async () => {
    const storage = memoryStorage();
    const unicode = { id: "p_unicodeproject01", label: "🎬".repeat(61) };
    const ordinary = { id: "p_ordinaryproject1", label: "Ordinary project" };
    await withSaveWorkspace(
      async ({ controller, edit, nextRequest, requests }) => {
        await Effect.runPromise(controller.restorationEffect());
        for (const project of [unicode, ordinary]) {
          edit({ id: project.id, name: project.label, revision: 0 });
          const started = nextRequest();
          const saving = controller.saveProject();
          await started;
          requests.at(-1)!.complete();
          expect((await saving)?.name).toBe(project.label);
          await flushPersistence();
        }
        expect(controller.recent().map(({ id, label }) => ({ id, label }))).toEqual([
          ordinary,
          unicode,
        ]);
      },
      { storage },
    );
    // A fresh workspace must restore both records from the same durable browser store.
    await withSaveWorkspace(
      async ({ controller }) => {
        await Effect.runPromise(controller.restorationEffect());
        expect(controller.recent().map(({ id, label }) => ({ id, label }))).toEqual([
          ordinary,
          unicode,
        ]);
      },
      { storage },
    );
  });

  it("waits for delayed recovery before considering remembered auto-load and dismisses only browser data", async () => {
    const read = deferred<string | undefined>();
    const started = deferred<void>();
    await withSaveWorkspace(
      async ({ controller, requests, reads, storage, state }) => {
        await started.promise;
        expect(controller.restoration().initialized).toBe(false);
        expect(reads).toEqual([]);
        expect(requests).toEqual([]);
        read.resolve(JSON.stringify(storedRecovery));
        await flushPersistence();
        expect(controller.recovery()?.name).toBe("Recovered");
        expect(state().status).toBe("Editing");
        expect(reads).toEqual([]);
        expect(requests).toEqual([]);
        controller.dismissRecovery();
        await flushPersistence();
        expect(controller.recovery()).toBeUndefined();
        expect(storage.getItem(recoveryKey)).toBeNull();
        expect(storage.getItem(rememberedProjectKey)).not.toBeNull();
        expect(state().revision).toBe(1);
      },
      {
        clean: true,
        stored: { [rememberedProjectKey]: JSON.stringify("p_remembered00001") },
        read: (key) =>
          key === recoveryKey
            ? Effect.promise(() => {
                started.resolve();
                return read.promise;
              })
            : Effect.succeed(
                key === rememberedProjectKey ? JSON.stringify("p_remembered00001") : undefined,
              ),
      },
    );
  });

  it("retains another project's recovery after a fully successful current save", async () => {
    await withSaveWorkspace(
      async ({ controller, requests, nextRequest, state }) => {
        await flushPersistence();
        const started = nextRequest();
        // No local edits means the explicit save need not replace another recovery snapshot.
        const saving = controller.saveProject();
        await started;
        requests[0].complete();
        await saving;
        await flushPersistence();
        expect(controller.recovery()?.projectId).toBe(storedRecovery.projectId);
        expect(state().dirty).toBe(false);
      },
      { clean: true, stored: { [recoveryKey]: JSON.stringify(storedRecovery) } },
    );
  });

  it("keeps editing and durable save success when reads/writes/removals fail", async () => {
    await withSaveWorkspace(
      async ({ controller, requests, nextRequest, state }) => {
        await flushPersistence();
        expect(controller.restoration().failure?.operation).toBe("read");
        const started = nextRequest();
        const saving = controller.saveProject();
        await started;
        expect(controller.recovery()?.name).toBe("Local edits");
        requests[0].complete();
        expect((await saving)?.revision).toBe(2);
        await flushPersistence();
        expect(state().dirty).toBe(false);
        expect(controller.saveState()).toBe("saved");
      },
      {
        failWrites: true,
        read: (key) =>
          Effect.fail(
            new KeyValueStore.KeyValueStoreError({ method: "get", key, message: "denied" }),
          ),
      },
    );
  });

  it("falls back from malformed identities and records, then caps and deduplicates recents", async () => {
    await withSaveWorkspace(
      async ({ controller, requests, nextRequest, edit }) => {
        await flushPersistence();
        expect(controller.recent()).toEqual([]);
        expect(controller.recovery()).toBeUndefined();
        for (let index = 0; index < 22; index++) {
          edit({ id: `p_recentproject${String(index).padStart(2, "0")}` });
          const started = nextRequest();
          const saving = controller.saveProject();
          await started;
          requests.at(-1)!.complete();
          await saving;
          await flushPersistence();
        }
        expect(controller.recent()).toHaveLength(20);
        const started = nextRequest();
        const saving = controller.saveProject();
        await started;
        requests.at(-1)!.complete();
        await saving;
        await flushPersistence();
        expect(controller.recent()).toHaveLength(20);
        expect(new Set(controller.recent().map((entry) => entry.id)).size).toBe(20);
      },
      {
        stored: {
          [recoveryKey]: "{bad",
          [rememberedProjectKey]: '"p_bad"',
          [recentProjectsKey]: '[{"id":"bad"}]',
        },
      },
    );
  });
});

describe("project restoration decisions", () => {
  it("restores browser recovery as a dirty import without server project writes", async () => {
    await withSaveWorkspace(
      async ({ controller, state, reads, requests }) => {
        await flushPersistence();
        await controller.recoverProject();
        expect(state().id).toBe(storedRecovery.projectId);
        expect(state().name).toBe("Recovered");
        expect(state().dirty).toBe(true);
        expect(controller.recovery()?.projectId).toBe(storedRecovery.projectId);
        expect(reads.every((url) => url.includes("/media/"))).toBe(true);
        expect(requests).toEqual([]);
      },
      { stored: { [recoveryKey]: JSON.stringify(storedRecovery) } },
    );
  });

  it.each([false, true])(
    "waits for delayed reads and auto-loads only an untouched workspace (edited=%s)",
    async (edited) => {
      const read = deferred<string | undefined>();
      const started = deferred<void>();
      await withSaveWorkspace(
        async ({ controller, state, reads, edit }) => {
          await started.promise;
          expect(reads).toEqual([]);
          if (edited) {
            edit({ name: "New local work" });
            controller.captureRecovery();
          }
          read.resolve(undefined);
          await Effect.runPromise(controller.restorationEffect());
          if (edited) {
            expect(reads).toEqual([]);
            expect(state().name).toBe("New local work");
            expect(controller.recovery()?.name).toBe("New local work");
          } else {
            expect(reads.some((url) => url.includes("/projects/p_remembered00001"))).toBe(true);
            expect(state().id).toBe("p_remembered00001");
            expect(state().dirty).toBe(false);
          }
        },
        {
          clean: true,
          read: (key) =>
            key === recoveryKey
              ? Effect.promise(() => {
                  started.resolve();
                  return read.promise;
                })
              : Effect.succeed(
                  key === rememberedProjectKey ? JSON.stringify("p_remembered00001") : undefined,
                ),
        },
      );
    },
  );
});

it("does not erase newer recovery while successful-save cleanup waits for initial storage", async () => {
  const read = deferred<string | undefined>();
  const reading = deferred<void>();
  await withSaveWorkspace(
    async ({ controller, nextRequest, requests, edit, storage }) => {
      await reading.promise;
      const started = nextRequest();
      const saving = controller.saveProject();
      await started;
      requests[0].complete();
      await saving;
      edit({ name: "After server save" });
      controller.captureRecovery();
      read.resolve(JSON.stringify(storedRecovery));
      await Effect.runPromise(controller.restorationEffect());
      await flushPersistence();
      expect(controller.recovery()?.name).toBe("After server save");
      expect(JSON.parse(storage.getItem(recoveryKey)!)).toMatchObject({
        name: "After server save",
      });
    },
    {
      read: (key) =>
        key === recoveryKey
          ? Effect.promise(() => {
              reading.resolve();
              return read.promise;
            })
          : Effect.succeed(undefined),
    },
  );
});
