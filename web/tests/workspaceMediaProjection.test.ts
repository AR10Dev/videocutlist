import { projectCommands } from "./projectCommands";
import type * as EffectApiTypes from "../src/generated/effect-api";
import type * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { Effect } from "effect";
import { RegistryContext, RegistryProvider } from "@effect/atom-solid";
import { createComponent, createRoot, untrack, useContext } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceController, type WorkspaceController } from "../src/app/controller";
import { serializeProjectItem } from "../src/features/projects/model";
import { memoryStorage } from "./memoryStorage";

type Media = EffectApiTypes.Media;
type Project = EffectApiTypes.Project;

const media = (id: string, name: string, etag = "v1"): Media => ({
  id,
  name,
  durationMs: 10_000,
  sizeBytes: 100,
  container: "mp4",
  streams: {},
  etag,
});
const mediaID = (letter: string) => `m_${letter.repeat(43)}`;
const itemID = (number: number) => `i_${String(number).padStart(24, "0")}`;
const projectID = (name: string) => `p_${name.padEnd(12, "0")}`;

const project = (id: string, sources: string[]): Project => ({
  id,
  revision: 7,
  updatedAt: "2026-01-01T00:00:00Z",
  schemaVersion: 2,
  name: id,
  items: sources.map((mediaId, index) => ({
    id: itemID(index + 1),
    mediaId,
    segments: [],
    editorState: { playheadMs: 0, zoom: 1, muted: false },
    exportOptions: {
      mode: "merge",
      selection: "segments",
      streamIndexes: [],
      cutStrategy: "stream_copy_preferred",
      container: "mkv",
      destinationId: "download",
      filenameTemplate: "{source}-{segment}.{ext}",
    },
  })),
});

const settings: EffectApiTypes.SettingsResponse = {
  revision: 1,
  schemaVersion: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  pathsConstrained: false,
  roots: {},
  settings: {
    destinations: [{ id: "download", label: "Downloads", kind: "download", retention: "24h" }],
    exportLimit: 2,
    cacheMaxBytes: 1_000_000,
    previewGlobalLimit: 2,
    previewBeforeMs: 1000,
    previewAfterMs: 1000,
    previewMaxMs: 5000,
    previewGridMs: 1000,
    mediaMaxFiles: 100,
    mediaMaxDepth: 4,
    mcpEnabled: false,
  },
};
const mcpSettings: EffectApiTypes.MCPSettingsResponse = {
  enabled: false,
  endpoint: "/mcp",
  authentication: "Bearer token",
  remoteAccessGuidance: "Use HTTPS for remote access.",
  clientCompatibility: "Streamable HTTP bearer-token clients only.",
  permissions: [],
  roots: [],
  credentials: [],
  proposals: [],
};

function until(
  check: () => boolean,
  describe: () => string = () => "workspace state",
): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) resolve();
      else if (Date.now() - started > 3000)
        reject(new Error(`Timed out waiting for ${describe()}.`));
      else setTimeout(poll, 0);
    };
    poll();
  });
}

type ProjectMediaLifecycle = {
  mounts: number;
  mountReleases: number;
  subscriptions: number;
  subscriptionReleases: number;
  listenerNotifications: number;
  notificationsAfterRelease: number;
};

type DeferredMetadataResponse = {
  deliver: (response: Response) => void;
  handedOff: Promise<void>;
};

function expectProjectMediaReleased(lifecycle: ProjectMediaLifecycle) {
  expect(lifecycle.mounts).toBeGreaterThan(0);
  expect(lifecycle.subscriptions).toBe(lifecycle.mounts);
  expect(lifecycle.mountReleases).toBe(lifecycle.mounts);
  expect(lifecycle.subscriptionReleases).toBe(lifecycle.subscriptions);
}

function mountWorkspace(options: {
  pageItems?: Media[];
  projects: Project[];
  currentMedia: (id: string) => Media;
  onRequest?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;
}) {
  const pending = new Map<string, DeferredMetadataResponse[]>();
  const deferredIDs = new Set<string>();
  let saveRequests = 0;
  const projects = new Map(options.projects.map((entry) => [entry.id, entry]));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const response = options.onRequest?.(url, init);
    if (response) return response;
    if (url.pathname === "/api/v2/media/tree")
      return Response.json({ folders: [], items: options.pageItems ?? [], nextCursor: null });
    if (url.pathname === "/api/v2/media/status")
      return Response.json({ state: "ready", message: "Media ready" });
    if (url.pathname === "/api/v2/settings") return Response.json(settings);
    if (url.pathname === "/api/v2/settings/mcp") return Response.json(mcpSettings);
    if (url.pathname === "/api/v2/destinations")
      return Response.json({ destinations: [], capabilities: { saveBesideSource: false } });
    if (url.pathname === "/api/v2/batches") return Response.json({ items: [], nextCursor: null });
    if (url.pathname.startsWith("/api/v2/projects/")) {
      const found = projects.get(url.pathname.split("/").at(-1) ?? "");
      if (!found) return new Response(null, { status: 404 });
      if (init?.method === "PUT") {
        saveRequests += 1;
        const input = JSON.parse(String(init.body)) as Omit<
          Project,
          "id" | "updatedAt" | "revision"
        >;
        return Response.json({
          ...found,
          ...input,
          revision: found.revision + 1,
          updatedAt: "2026-01-02T00:00:00Z",
        });
      }
      return Response.json(found);
    }
    const metadataPrefix = "/api/v2/media/";
    if (url.pathname.startsWith(metadataPrefix) && url.pathname !== `${metadataPrefix}tree`) {
      const id = decodeURIComponent(url.pathname.slice(metadataPrefix.length));
      if (deferredIDs.has(id)) {
        let acknowledgeHandoff!: () => void;
        const handedOff = new Promise<void>((resolve) => {
          acknowledgeHandoff = resolve;
        });
        const response = new Promise<Response>((resolve) => {
          const queue = pending.get(id) ?? [];
          queue.push({ deliver: resolve, handedOff });
          pending.set(id, queue);
        });
        return response.then(async (value) => {
          await value.clone().arrayBuffer();
          acknowledgeHandoff();
          return value;
        });
      }
      return Response.json(options.currentMedia(id));
    }
    return new Response(null, { status: 404 });
  });

  const browser = Object.assign(new EventTarget(), {
    location: new URL("https://example.test"),
    confirm: () => true,
  }) as unknown as Window;
  vi.stubGlobal("window", browser);
  vi.stubGlobal("localStorage", memoryStorage());
  const trackedProjectAtoms = new Map<object, ProjectMediaLifecycle>();
  const mountingProjectAtoms = new Set<object>();
  let controller!: WorkspaceController;
  let dispose!: () => void;
  createRoot((rootDispose) => {
    dispose = rootDispose;
    createComponent(RegistryProvider, {
      get children() {
        untrack(() => {
          useContext(RegistryContext);
          controller = createWorkspaceController();
          const registry = controller.server.registry;
          const originalMount = registry.mount.bind(registry);
          Object.defineProperty(registry, "mount", {
            configurable: true,
            value: <A>(atom: Atom.Atom<A>) => {
              const lifecycle = trackedProjectAtoms.get(atom);
              if (!lifecycle) return originalMount(atom);
              lifecycle.mounts += 1;
              mountingProjectAtoms.add(atom);
              let release: () => void;
              try {
                release = originalMount(atom);
              } finally {
                mountingProjectAtoms.delete(atom);
              }
              let released = false;
              return () => {
                if (!released) {
                  released = true;
                  lifecycle.mountReleases += 1;
                }
                release();
              };
            },
          });
          const originalSubscribe = registry.subscribe.bind(registry);
          Object.defineProperty(registry, "subscribe", {
            configurable: true,
            value: <A>(
              atom: Atom.Atom<A>,
              listener: (value: A) => void,
              options?: { readonly immediate?: boolean },
            ) => {
              const lifecycle = trackedProjectAtoms.get(atom);
              if (!lifecycle || mountingProjectAtoms.has(atom))
                return originalSubscribe(atom, listener, options);
              let released = false;
              const unsubscribe = originalSubscribe(
                atom,
                (value) => {
                  lifecycle.listenerNotifications += 1;
                  if (released) lifecycle.notificationsAfterRelease += 1;
                  listener(value);
                },
                options,
              );
              lifecycle.subscriptions += 1;
              return () => {
                if (!released) {
                  released = true;
                  lifecycle.subscriptionReleases += 1;
                }
                unsubscribe();
              };
            },
          });
        });
        return null;
      },
    });
  });

  return {
    controller,
    dispose,
    saveRequests: () => saveRequests,
    defer(id: string) {
      deferredIDs.add(id);
    },
    async resolveDeferred(id: string, value: Media) {
      deferredIDs.delete(id);
      const queue = pending.get(id) ?? [];
      pending.delete(id);
      for (const request of queue) request.deliver(Response.json(value));
      await Promise.all(queue.map((request) => request.handedOff));
    },
    pendingCount: (id: string) => pending.get(id)?.length ?? 0,
    watchProjectMedia(id: string, revision: number): ProjectMediaLifecycle {
      const lifecycle: ProjectMediaLifecycle = {
        mounts: 0,
        mountReleases: 0,
        subscriptions: 0,
        subscriptionReleases: 0,
        listenerNotifications: 0,
        notificationsAfterRelease: 0,
      };
      trackedProjectAtoms.set(controller.server.media(id, revision), lifecycle);
      return lifecycle;
    },
  };
}

describe("workspace project media projection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("marks each export option edit dirty with one workspace update", async () => {
    const source = media(mediaID("o"), "options.mp4");
    const saved = project(projectID("options"), [source.id]);
    const harness = mountWorkspace({ projects: [saved], currentMedia: () => source });
    const { controller } = harness;
    const update = vi.spyOn(controller.server.registry, "update");
    const autosave = vi.spyOn(controller.projects, "scheduleAutosave");
    try {
      await projectCommands(controller.server.registry, controller.projects).loadProject(saved.id);
      const edits = [
        () => controller.export.setMode("separate"),
        () => controller.export.setSelection("gaps"),
        () => controller.export.setStrategy("precise_reencode"),
        () => controller.export.setContainer("mp4"),
        () => controller.export.setDestination("download"),
        () => controller.export.setItemDestination(saved.items[0].id, "download"),
        () => controller.export.setTemplate("{source}.{ext}"),
        () => controller.export.setStreams([2]),
      ];
      for (const edit of edits) {
        update.mockClear();
        autosave.mockClear();
        const version = controller.editorVersion();
        edit();
        expect(controller.dirty()).toBe(true);
        expect(controller.editorVersion()).toBe(version + 1);
        expect(autosave).toHaveBeenCalledTimes(1);
        expect(
          update.mock.calls.filter(([atom]) => atom === controller.workspaceIdentity),
        ).toHaveLength(1);
      }
    } finally {
      update.mockRestore();
      autosave.mockRestore();
      harness.dispose();
    }
  });

  it("saves a clean project's destination fallback before fresh preflight and Create clips", async () => {
    const source = media(mediaID("f"), "fallback.mp4");
    const original = project(projectID("fallback"), [source.id]);
    const saved: Project = {
      ...original,
      items: original.items.map((item) => ({
        ...item,
        segments: [{ id: "s_fallback", startMs: 0, endMs: 1000 }],
        exportOptions: { ...item.exportOptions, destinationId: "missing" },
      })),
    };
    let resolveDestinations!: (response: Response) => void;
    const destinations = new Promise<Response>((resolve) => (resolveDestinations = resolve));
    const calls: string[] = [];
    let submitted: EffectApiTypes.ExportSubmissionInput | undefined;
    const harness = mountWorkspace({
      projects: [saved],
      currentMedia: () => source,
      onRequest: (url, init) => {
        if (url.pathname === "/api/v2/destinations") return destinations;
        if (init?.method === "PUT") {
          calls.push("save");
          const payload = JSON.parse(String(init.body)) as EffectApiTypes.ProjectInput;
          expect(payload.revision).toBe(saved.revision);
          expect(payload.items[0].exportOptions.destinationId).toBe("download");
          return Response.json({ ...saved, ...payload, revision: saved.revision + 1 });
        }
        if (url.pathname.endsWith("/exports/preflight")) {
          calls.push("preflight");
          expect(JSON.parse(String(init?.body)).destinationId).toBe("download");
          return Response.json({ allowed: true, selection: [], findings: [] });
        }
        if (url.pathname.endsWith("/exports")) {
          calls.push("export");
          submitted = JSON.parse(String(init?.body)) as EffectApiTypes.ExportSubmissionInput;
          return Response.json({ batchId: "b_fallback000001", jobs: [] }, { status: 202 });
        }
      },
    });
    const { controller } = harness;
    const scheduleAutosave = vi.spyOn(controller.projects, "scheduleAutosave");
    try {
      await projectCommands(controller.server.registry, controller.projects).loadProject(saved.id);
      expect(controller.dirty()).toBe(false);
      expect(controller.projects.saveState()).toBe("saved");
      const version = controller.editorVersion();
      resolveDestinations(
        Response.json({
          destinations: [{ id: "download", label: "Downloads", kind: "download" }],
          capabilities: { saveBesideSource: false },
        }),
      );
      await until(() => controller.export.destinationId() === "download");
      expect(controller.dirty()).toBe(true);
      expect(controller.editorVersion()).toBe(version + 1);
      expect(scheduleAutosave).toHaveBeenCalledTimes(1);
      expect(controller.export.destinationStatus()).toBe(
        "Remembered destination is unavailable. Using Downloads.",
      );
      controller.server.registry.refresh(controller.export.optionsAtom);
      controller.export.retryDestinations();
      await until(() => !controller.export.destinationsLoading());
      expect(controller.editorVersion()).toBe(version + 1);
      expect(scheduleAutosave).toHaveBeenCalledTimes(1);
      calls.length = 0;
      controller.export.exportProject();
      await Effect.runPromise(
        AtomRegistry.getResult(controller.server.registry, controller.export.exportCommand, {
          suspendOnWaiting: true,
        }),
      );
      expect(calls).toEqual(["save", "preflight", "export"]);
      expect(submitted).toEqual({ projectRevision: saved.revision + 1 });
      expect(controller.dirty()).toBe(false);
      expect(controller.revision()).toBe(saved.revision + 1);
    } finally {
      harness.dispose();
    }
  });

  it("keeps a destination fallback during a captured save unsaved until the next revision saves it", async () => {
    const source = media(mediaID("g"), "save-fallback.mp4");
    const original = project(projectID("savefallback"), [source.id]);
    const saved: Project = {
      ...original,
      items: original.items.map((item) => ({
        ...item,
        segments: [{ id: "s_fallback", startMs: 0, endMs: 1000 }],
        exportOptions: { ...item.exportOptions, destinationId: "missing" },
      })),
    };
    let resolveDestinations!: (response: Response) => void;
    const destinations = new Promise<Response>((resolve) => (resolveDestinations = resolve));
    const saves: { payload: EffectApiTypes.ProjectInput; respond: (response: Response) => void }[] =
      [];
    const harness = mountWorkspace({
      projects: [saved],
      currentMedia: () => source,
      onRequest: (url, init) => {
        if (url.pathname === "/api/v2/destinations") return destinations;
        if (init?.method === "PUT")
          return new Promise<Response>((respond) =>
            saves.push({
              payload: JSON.parse(String(init.body)) as EffectApiTypes.ProjectInput,
              respond,
            }),
          );
      },
    });
    const { controller } = harness;
    const scheduleAutosave = vi.spyOn(controller.projects, "scheduleAutosave");
    try {
      await projectCommands(controller.server.registry, controller.projects).loadProject(saved.id);
      expect(controller.dirty()).toBe(false);
      const version = controller.editorVersion();
      const saving = projectCommands(controller.server.registry, controller.projects).saveProject();
      await until(() => saves.length === 1);
      expect(saves[0].payload.items[0].exportOptions.destinationId).toBe("missing");
      resolveDestinations(
        Response.json({
          destinations: [{ id: "download", label: "Downloads", kind: "download" }],
          capabilities: { saveBesideSource: false },
        }),
      );
      await until(() => controller.export.destinationId() === "download");
      expect(controller.dirty()).toBe(true);
      expect(controller.editorVersion()).toBe(version + 1);
      expect(scheduleAutosave).toHaveBeenCalledTimes(1);
      saves[0].respond(
        Response.json({ ...saved, ...saves[0].payload, revision: saved.revision + 1 }),
      );
      await until(() => saves.length === 2);
      expect(controller.dirty()).toBe(true);
      expect(controller.projects.saveState()).toBe("saving");
      expect(controller.status()).toBe("Project saved; newer edits remain unsaved.");
      expect(controller.revision()).toBe(saved.revision + 1);
      expect(saves[1].payload.revision).toBe(saved.revision + 1);
      expect(saves[1].payload.items[0].exportOptions.destinationId).toBe("download");
      expect(saves[0].payload.items[0].exportOptions.destinationId).toBe("missing");
      saves[1].respond(
        Response.json({ ...saved, ...saves[1].payload, revision: saved.revision + 2 }),
      );
      await saving;
      expect(controller.dirty()).toBe(false);
      expect(controller.projects.saveState()).toBe("saved");
      expect(controller.revision()).toBe(saved.revision + 2);
      expect(controller.editorVersion()).toBe(version + 1);
      expect(scheduleAutosave).toHaveBeenCalledTimes(1);
    } finally {
      harness.dispose();
    }
  });

  it("does not dirty the document for a preview-only remembered destination fallback", async () => {
    const source = media(mediaID("h"), "preview-fallback.mp4");
    let resolveDestinations!: (response: Response) => void;
    const destinations = new Promise<Response>((resolve) => (resolveDestinations = resolve));
    const harness = mountWorkspace({
      projects: [],
      pageItems: [source],
      currentMedia: () => source,
      onRequest: (url) => (url.pathname === "/api/v2/destinations" ? destinations : undefined),
    });
    const { controller } = harness;
    const { registry, preferences } = controller.server;
    const scheduleAutosave = vi.spyOn(controller.projects, "scheduleAutosave");
    try {
      await Effect.runPromise(
        AtomRegistry.getResult(registry, preferences.initialize, { suspendOnWaiting: true }),
      );
      registry.update(preferences.value, (value) => ({ ...value, lastDestinationId: "missing" }));
      controller.chooseMedia(source);
      const version = controller.editorVersion();
      resolveDestinations(
        Response.json({
          destinations: [{ id: "download", label: "Downloads", kind: "download" }],
          capabilities: { saveBesideSource: false },
        }),
      );
      await until(() => controller.export.destinationId() === "download");
      expect(controller.export.destinationStatus()).toBe(
        "Remembered destination is unavailable. Using Downloads.",
      );
      expect(controller.projectItems()).toEqual([]);
      expect(controller.dirty()).toBe(false);
      expect(controller.editorVersion()).toBe(version);
      expect(scheduleAutosave).not.toHaveBeenCalled();
      expect(registry.get(preferences.value).lastDestinationId).toBe("missing");
    } finally {
      harness.dispose();
    }
  });

  it("dispatches void project commands and writes mute edits to the authoritative member", async () => {
    const firstID = mediaID("a");
    const secondID = mediaID("b");
    const saved = project(projectID("mute-owner"), [firstID, secondID]);
    const harness = mountWorkspace({
      pageItems: [],
      projects: [saved],
      currentMedia: (id) => media(id, "mute.mp4"),
    });
    const { controller } = harness;
    try {
      expect(controller.projects.loadProject(saved.id)).toBeUndefined();
      await Effect.runPromise(
        AtomRegistry.getResult(controller.server.registry, controller.projects.loadCommand, {
          suspendOnWaiting: true,
        }),
      );
      controller.setMuted(true);
      expect(controller.projectItems()[0].muted).toBe(true);
      expect(controller.editableItems()[0].muted).toBe(true);
      controller.activateItem(controller.projectItems()[1]);
      controller.setMuted(false);
      controller.activateItem(controller.projectItems()[0]);
      expect(controller.muted()).toBe(true);
      expect(controller.projectItems()[1].muted).toBe(false);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(controller.muted()).toBe(true);
      expect(controller.projects.saveProject()).toBeUndefined();
      await Effect.runPromise(
        AtomRegistry.getResult(
          controller.server.registry,
          controller.projects.explicitSaveCommand,
          { suspendOnWaiting: true },
        ),
      );
      expect(controller.projects.saveState()).toBe("saved");
    } finally {
      harness.dispose();
    }
  });

  it("keeps clean viewing separate from dirty project/editor persistence", async () => {
    const pageID = mediaID("p");
    const overlapID = mediaID("o");
    const secondID = mediaID("b");
    const thirdID = mediaID("c");
    const pageMedia = media(pageID, "page.mp4");
    const pageOverlap = media(overlapID, "page-overlap.mp4", "page-etag");
    const saved = project(projectID("projection"), [secondID, overlapID, thirdID, secondID]);
    let refreshed = false;
    const harness = mountWorkspace({
      pageItems: [pageMedia, pageOverlap],
      projects: [saved],
      currentMedia: (id) =>
        id === overlapID
          ? media(id, refreshed ? "server-overlap-v2.mp4" : "server-overlap.mp4", "server-etag")
          : media(
              id,
              refreshed ? `${id.slice(0, 5)}-v2.mp4` : `${id.slice(0, 5)}.mp4`,
              refreshed ? "v2" : "v1",
            ),
    });
    const { controller } = harness;
    try {
      await until(() => controller.server.registry.get(controller.library.view).media.length === 2);
      await projectCommands(controller.server.registry, controller.projects).loadProject(saved.id);
      await until(() => controller.visibleMedia().length === 4);
      expect(controller.visibleMedia().map((item) => item.id)).toEqual([
        pageID,
        overlapID,
        secondID,
        thirdID,
      ]);
      expect(controller.visibleMedia()[1]?.name).toBe("page-overlap.mp4");
      expect(controller.visibleMedia().filter((item) => item.id === secondID)).toHaveLength(1);

      expect(controller.dirty()).toBe(false);
      const cleanState = {
        items: controller.editableItems().map((item) => ({
          media: item.media,
          persisted: serializeProjectItem(item),
        })),
        timeline: controller.editor.timeline(),
        revision: controller.revision(),
      };
      let autosaveSchedules = 0;
      const scheduleAutosave = controller.projects.scheduleAutosave;
      controller.projects.scheduleAutosave = () => {
        autosaveSchedules += 1;
        scheduleAutosave();
      };
      const cleanContext = controller.editorContext();
      const cleanEditVersion = controller.editorVersion();
      refreshed = true;
      controller.server.refreshMedia();
      await until(
        () => controller.visibleMedia().find((item) => item.id === secondID)?.etag === "v2",
      );
      expect(controller.dirty()).toBe(false);
      expect(controller.editorContext()).toBe(cleanContext);
      expect(controller.editorVersion()).toBe(cleanEditVersion);
      expect(autosaveSchedules).toBe(0);
      controller.chooseMedia(controller.visibleMedia().find((item) => item.id === thirdID)!);
      await until(
        () => controller.selected()?.id === thirdID && controller.selected()?.etag === "v2",
      );
      expect(controller.dirty()).toBe(false);
      expect(autosaveSchedules).toBe(0);
      controller.chooseMedia(controller.visibleMedia().find((item) => item.id === secondID)!);
      await until(
        () => controller.selected()?.id === secondID && controller.selected()?.etag === "v2",
      );
      expect(controller.dirty()).toBe(false);
      expect(autosaveSchedules).toBe(0);
      expect(controller.revision()).toBe(cleanState.revision);
      expect(
        controller.editableItems().map((item) => ({
          media: item.media,
          persisted: serializeProjectItem(item),
        })),
      ).toEqual(cleanState.items);
      expect(controller.editor.timeline()).toEqual(cleanState.timeline);
      expect(autosaveSchedules).toBe(0);
      expect(harness.saveRequests()).toBe(0);

      controller.projects.scheduleAutosave = () => undefined;
      controller.editor.updateTimeline({
        segments: [{ id: "s_projection-one", startMs: 100, endMs: 200 }],
      });
      controller.editor.updateTimeline({
        segments: [
          { id: "s_projection-one", startMs: 100, endMs: 200 },
          { id: "s_projection-two", startMs: 300, endMs: 400 },
        ],
      });
      expect(controller.dirty()).toBe(true);
      controller.editProjectName("User project name");
      controller.setStatus("User notice");
      const dirtyEditVersion = controller.editorVersion();
      const dirtyContext = controller.editorContext();
      const dirtyState = {
        items: controller.editableItems().map((item) => ({
          media: item.media,
          persisted: serializeProjectItem(item),
        })),
        fingerprints: controller.projectItems().map(({ id, media: source }) => ({
          id,
          mediaID: source.id,
          etag: source.etag,
        })),
        timeline: controller.editor.timeline(),
        revision: controller.revision(),
      };
      expect(controller.editor.timeline().past).toHaveLength(2);

      controller.server.refreshMedia();
      await until(
        () => controller.visibleMedia().find((item) => item.id === secondID)?.etag === "v2",
      );
      expect(controller.projectName()).toBe("User project name");
      expect(controller.status()).toBe("User notice");
      expect(controller.editorContext()).toBe(dirtyContext);
      expect(controller.editorVersion()).toBe(dirtyEditVersion);
      controller.chooseMedia(controller.visibleMedia().find((item) => item.id === thirdID)!);
      await until(
        () => controller.selected()?.id === thirdID && controller.selected()?.etag === "v2",
      );
      controller.chooseMedia(controller.visibleMedia().find((item) => item.id === secondID)!);
      await until(
        () => controller.selected()?.id === secondID && controller.selected()?.etag === "v2",
      );

      expect(controller.projectName()).toBe("User project name");
      expect(controller.editorVersion()).toBe(dirtyEditVersion);
      expect(controller.editorContext()).not.toBe(dirtyContext);
      expect(controller.dirty()).toBe(true);
      expect(controller.revision()).toBe(dirtyState.revision);
      expect(
        controller.editableItems().map((item) => ({
          media: item.media,
          persisted: serializeProjectItem(item),
        })),
      ).toEqual(dirtyState.items);
      expect(controller.editor.timeline()).toEqual(dirtyState.timeline);
      expect(
        controller.projectItems().map(({ id, media: source }) => ({
          id,
          mediaID: source.id,
          etag: source.etag,
        })),
      ).toEqual(dirtyState.fingerprints);
      expect(controller.projectItems().find((item) => item.media.id === secondID)?.media.etag).toBe(
        "v1",
      );
      expect(controller.visibleMedia().find((item) => item.id === secondID)?.etag).toBe("v2");
      const beforeReset = controller.editor.timeline();
      const beforeResetContext = controller.editorContext();
      controller.projects.newProject(false);
      expect(controller.editor.timeline()).toBe(beforeReset);
      expect(controller.editorContext()).toBe(beforeResetContext);
      expect(controller.projectName()).toBe("User project name");
      expect(controller.dirty()).toBe(true);
      controller.projects.newProject(true);
      expect(controller.editor.timeline()).toEqual({
        past: [],
        present: { playheadMs: 0, segments: [], zoom: 1 },
        future: [],
      });
      expect(controller.editor.activeSegment()).toBeUndefined();
      expect(controller.editor.boundaryDrafts()).toEqual({});
      expect(controller.editor.labelDrafts()).toEqual({});
      expect(controller.activeItemId()).toBeUndefined();
      expect(controller.selected()).toBeUndefined();
      expect(controller.dirty()).toBe(false);
      expect(controller.projectName()).toBe("Untitled project");
    } finally {
      harness.dispose();
    }
  });

  it.each(["item", "project"] as const)(
    "does not continue detection or publish a late shared save after a workspace %s switch",
    async (switchTo) => {
      const first = media(mediaID("a"), "first.mp4");
      const second = media(mediaID("b"), "second.mp4");
      const original = project(projectID("pending-work"), [first.id, second.id]);
      let savedInput: EffectApiTypes.ProjectInput | undefined;
      let deliver!: (response: Response) => void;
      let detections = 0;
      let cancellations = 0;
      const harness = mountWorkspace({
        pageItems: [first, second],
        projects: [original],
        currentMedia: (id) => (id === first.id ? first : second),
        onRequest: (url, init) => {
          if (init?.method === "DELETE") cancellations++;
          if (url.pathname.endsWith("/detections")) detections++;
          if (url.pathname === `/api/v2/projects/${original.id}` && init?.method === "PUT") {
            savedInput = JSON.parse(String(init.body)) as EffectApiTypes.ProjectInput;
            return new Promise<Response>((resolve) => {
              deliver = resolve;
            });
          }
        },
      });
      const { controller } = harness;
      try {
        await projectCommands(controller.server.registry, controller.projects).loadProject(
          original.id,
        );
        controller.editor.updateTimeline({
          segments: [{ id: "s_pending", startMs: 100, endMs: 700 }],
        });
        controller.detection.startDetection("black");
        await until(() => savedInput !== undefined);
        expect(savedInput!.items[0].segments).toEqual([
          expect.objectContaining({ startMs: 100, endMs: 700 }),
        ]);
        if (switchTo === "item") controller.chooseMedia(second);
        else controller.projects.newProject(true);
        const current = {
          projectId: controller.projectId(),
          activeItemId: controller.activeItemId(),
          revision: controller.revision(),
          status: controller.status(),
          items: controller.projectItems(),
          timeline: controller.editor.timeline(),
        };
        deliver(
          Response.json({
            ...savedInput,
            id: original.id,
            revision: original.revision + 1,
            updatedAt: "2026-01-02T00:00:00Z",
          }),
        );
        await until(
          () =>
            !controller.projects.saveResult().waiting &&
            !controller.detection.startResult().waiting,
        );
        expect(controller.projectId()).toBe(current.projectId);
        expect(controller.activeItemId()).toBe(current.activeItemId);
        expect(controller.revision()).toBe(current.revision);
        expect(controller.status()).toBe(current.status);
        expect(controller.projectItems()).toBe(current.items);
        expect(controller.editor.timeline()).toBe(current.timeline);
        expect(controller.detection.detectionJob()).toBeUndefined();
        expect(controller.detection.detectionCandidates()).toEqual([]);
        expect(detections).toBe(0);
        expect(cancellations).toBe(0);
      } finally {
        harness.dispose();
      }
    },
  );

  it("owns membership histories and confirmed removal without preview membership", async () => {
    const first = media(mediaID("a"), "first.mp4");
    const second = media(mediaID("b"), "second.mp4");
    const harness = mountWorkspace({
      pageItems: [first, second],
      projects: [],
      currentMedia: (id) => (id === first.id ? first : second),
    });
    const { controller } = harness;
    try {
      await until(() => controller.server.registry.get(controller.library.view).media.length === 2);
      controller.projects.scheduleAutosave = () => undefined;
      controller.chooseMedia(first);
      expect(controller.projectItems()).toHaveLength(0);
      controller.editor.setMarker("inMs", 100);
      controller.editor.setMarker("outMs", 100);
      expect(controller.projectItems()).toHaveLength(0);
      controller.editor.setMarker("outMs", 700);
      expect(controller.projectItems()).toHaveLength(1);
      const firstID = controller.activeItemId()!;
      controller.editor.updateTimeline({
        segments: [{ id: "s_membership", startMs: 100, endMs: 800 }],
      });
      const history = controller.editor.timeline();
      expect(controller.projectItems()[0].timeline).toBe(history);
      controller.setMuted(true);
      controller.export.setItemDestination(firstID, "archive");
      controller.chooseMedia(second);
      expect(controller.projectItems()).toHaveLength(1);
      controller.editor.setMarker("inMs", 200);
      controller.editor.setMarker("outMs", 900);
      const secondID = controller.activeItemId()!;
      controller.chooseMedia(first);
      expect(controller.projectItems()).toHaveLength(2);
      expect(controller.editor.timeline()).toBe(history);
      expect(controller.muted()).toBe(true);
      expect(controller.editableItems()[0].exportOptions.destinationId).toBe("archive");
      controller.editor.undo();
      expect(controller.projectItems()[0].timeline).toBe(controller.editor.timeline());
      controller.editor.redo();
      expect(controller.editor.timeline().present).toEqual(history.present);
      controller.setDirty(false);
      const version = controller.editorVersion();
      controller.reorderProjectItem(firstID, -1);
      expect(controller.dirty()).toBe(false);
      expect(controller.editorVersion()).toBe(version);
      controller.reorderProjectItem(firstID, 1);
      expect(controller.projectItems().map((item) => item.id)).toEqual([secondID, firstID]);
      expect(controller.dirty()).toBe(true);
      controller.removeProjectItem(firstID, false);
      expect(controller.projectItems()).toHaveLength(2);
      controller.removeProjectItem(firstID, true);
      expect(controller.activeItemId()).toBe(secondID);
      expect(controller.selected()?.id).toBe(second.id);
      controller.removeProjectItem(secondID, true);
      expect(controller.projectItems()).toHaveLength(0);
      expect(controller.selected()).toBeUndefined();
      expect(controller.editor.timeline().present.segments).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  it.each(["existing member", "new media preview"] as const)(
    "chooseMedia prepares once for %s and retains cleared outgoing drafts",
    async (target) => {
      const first = media(mediaID("a"), "first.mp4");
      const second = media(mediaID("b"), "second.mp4");
      const preview = media(mediaID("c"), "preview.mp4");
      const empty = project(projectID("switchmarks"), [first.id, second.id]);
      const saved: Project = {
        ...empty,
        items: empty.items.map((item, index) => ({
          ...item,
          segments: [{ id: `s_switch-${index}`, startMs: 100, endMs: 700 }],
        })),
      };
      const harness = mountWorkspace({
        pageItems: [first, second, preview],
        projects: [saved],
        currentMedia: (id) => [first, second, preview].find((item) => item.id === id)!,
      });
      const { controller } = harness;
      const editor = controller.editor;
      try {
        await projectCommands(controller.server.registry, controller.projects).loadProject(
          saved.id,
        );
        controller.projects.scheduleAutosave = () => undefined;
        editor.updateSegment(0, { boundary: "end", valueMs: 800 });
        editor.undo();
        const firstHistory = editor.timeline();
        const secondHistory = controller.projectItems()[1].timeline;
        const firstSegment = editor.present().segments[0].id!;
        const context = controller.editorContext();
        const version = controller.editorVersion();
        editor.startSegmentAt(2000);
        editor.setBoundaryDraft(firstSegment, "start", "invalid");
        editor.beginDrag();
        editor.previewMarker("inMs", 2500);
        const prepare = vi.spyOn(editor, "prepareMediaSwitch");

        controller.chooseMedia(target === "existing member" ? second : preview);

        expect(prepare).toHaveBeenCalledTimes(1);
        expect(editor.editorStatus()).toBe("Incomplete marks were discarded when switching media.");
        expect(editor.present().inMs).toBeUndefined();
        expect(editor.present().outMs).toBeUndefined();
        expect(editor.activeSegment()).toBeUndefined();
        expect(editor.boundaryDrafts()).toEqual({});
        expect(controller.projectItems().map((item) => item.id)).toEqual([itemID(1), itemID(2)]);
        expect(controller.projectItems()[0].timeline).toEqual(firstHistory);
        expect(controller.projectItems()[0].timeline.future).toBe(firstHistory.future);
        expect(controller.projectItems()[1].timeline).toBe(secondHistory);
        expect(controller.selected()?.id).toBe(
          target === "existing member" ? second.id : preview.id,
        );
        expect(controller.activeItemId()).toBe(
          target === "existing member" ? itemID(2) : undefined,
        );
        expect(controller.editorContext()).not.toBe(context);
        expect(controller.editorVersion()).toBe(version);
        const incomingHistory = editor.timeline();
        editor.commitDrag("draft-in");
        expect(editor.timeline()).toBe(incomingHistory);

        if (target === "existing member") {
          editor.setActiveSegmentIndex(0);
          editor.setBoundaryDraft(editor.activeSegment()!.id!, "end", "invalid");
          const beforeDrag = editor.timeline();
          editor.beginDrag();
          editor.previewSegment(0, { startMs: 3000 });
          prepare.mockClear();
          controller.chooseMedia(first);
          expect(prepare).toHaveBeenCalledTimes(1);
          expect(controller.projectItems()[1].timeline).toBe(beforeDrag);
          expect(editor.activeSegment()).toBeUndefined();
          expect(editor.boundaryDrafts()).toEqual({});
          editor.commitDrag("segment");
        } else {
          controller.chooseMedia(first);
        }
        expect(editor.timeline()).toEqual(firstHistory);
        expect(editor.present().inMs).toBeUndefined();
        expect(editor.present().outMs).toBeUndefined();
        expect(editor.editorStatus()).toBe("");
        editor.redo();
        expect(editor.present().segments[0].endMs).toBe(800);
      } finally {
        harness.dispose();
      }
    },
  );

  it("releases unselected project media resources on replacement and removal", async () => {
    const oldSelectedID = mediaID("s");
    const oldUnselectedID = mediaID("a");
    const nextSelectedID = mediaID("n");
    const removedID = mediaID("r");
    const oldProject = project(projectID("oldproject"), [oldSelectedID, oldUnselectedID]);
    const replacement = project(projectID("newproject"), [nextSelectedID, removedID]);
    const harness = mountWorkspace({
      projects: [oldProject, replacement],
      currentMedia: (id) => media(id, `${id.slice(0, 5)}.mp4`),
    });
    const { controller } = harness;
    try {
      await projectCommands(controller.server.registry, controller.projects).loadProject(
        oldProject.id,
      );
      const replacementRevision =
        controller.server.registry.get(controller.server.mediaRevision) + 1;
      const replacedLifecycle = harness.watchProjectMedia(oldUnselectedID, replacementRevision);
      // The tracked source is not selected, so these are project-display lifecycle handles.
      expect(controller.selected()?.id).toBe(oldSelectedID);
      harness.defer(oldUnselectedID);
      controller.server.refreshMedia();
      await until(
        () =>
          replacedLifecycle.mounts === 1 &&
          replacedLifecycle.subscriptions === 1 &&
          harness.pendingCount(oldUnselectedID) > 0,
        () =>
          `replacement resource lifecycle ${JSON.stringify(replacedLifecycle)}, pending=${harness.pendingCount(oldUnselectedID)}, revision=${controller.server.registry.get(controller.server.mediaRevision)}`,
      );
      await projectCommands(controller.server.registry, controller.projects).loadProject(
        replacement.id,
      );
      await until(() => replacedLifecycle.mountReleases === replacedLifecycle.mounts);
      expectProjectMediaReleased(replacedLifecycle);
      expect(controller.visibleMedia().map((item) => item.id)).toEqual([nextSelectedID, removedID]);
      const notificationsBeforeLateReplacementResponse = replacedLifecycle.listenerNotifications;
      await harness.resolveDeferred(
        oldUnselectedID,
        media(oldUnselectedID, "late-replaced.mp4", "late"),
      );
      expect(replacedLifecycle.listenerNotifications).toBe(
        notificationsBeforeLateReplacementResponse,
      );
      expect(replacedLifecycle.notificationsAfterRelease).toBe(0);
      expect(controller.visibleMedia().some((item) => item.name === "late-replaced.mp4")).toBe(
        false,
      );

      const removalRevision = controller.server.registry.get(controller.server.mediaRevision) + 1;
      const removedLifecycle = harness.watchProjectMedia(removedID, removalRevision);
      expect(controller.selected()?.id).toBe(nextSelectedID);
      harness.defer(removedID);
      controller.server.refreshMedia();
      await until(
        () =>
          removedLifecycle.mounts === 1 &&
          removedLifecycle.subscriptions === 1 &&
          harness.pendingCount(removedID) > 0,
        () =>
          `removal resource lifecycle ${JSON.stringify(removedLifecycle)}, pending=${harness.pendingCount(removedID)}, revision=${controller.server.registry.get(controller.server.mediaRevision)}`,
      );
      const notificationsBeforeRemoval = removedLifecycle.listenerNotifications;
      controller.removeProjectItem(itemID(2), true);
      await until(() => !controller.visibleMedia().some((item) => item.id === removedID));
      await until(() => removedLifecycle.mountReleases === removedLifecycle.mounts);
      expectProjectMediaReleased(removedLifecycle);
      await harness.resolveDeferred(removedID, media(removedID, "late-removed.mp4", "late"));
      expect(removedLifecycle.listenerNotifications).toBe(notificationsBeforeRemoval);
      expect(removedLifecycle.notificationsAfterRelease).toBe(0);
      expect(controller.visibleMedia().map((item) => item.id)).toEqual([nextSelectedID]);
      expect(controller.dirty()).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it("releases unselected project media resources before workspace registry disposal", async () => {
    const selectedID = mediaID("d");
    const unselectedID = mediaID("u");
    const saved = project(projectID("disposedproject"), [selectedID, unselectedID]);
    const harness = mountWorkspace({
      projects: [saved],
      currentMedia: (id) => media(id, `${id.slice(0, 5)}.mp4`, "original-etag"),
    });
    const { controller } = harness;
    let disposed = false;
    try {
      await projectCommands(controller.server.registry, controller.projects).loadProject(saved.id);
      const revision = controller.server.registry.get(controller.server.mediaRevision) + 1;
      const lifecycle = harness.watchProjectMedia(unselectedID, revision);
      expect(controller.selected()?.id).toBe(selectedID);
      harness.defer(unselectedID);
      controller.server.refreshMedia();
      await until(
        () =>
          lifecycle.mounts === 1 &&
          lifecycle.subscriptions === 1 &&
          harness.pendingCount(unselectedID) > 0,
        () =>
          `disposal resource lifecycle ${JSON.stringify(lifecycle)}, pending=${harness.pendingCount(unselectedID)}, revision=${controller.server.registry.get(controller.server.mediaRevision)}`,
      );
      const notificationsBeforeDisposal = lifecycle.listenerNotifications;
      const beforeDispose = controller
        .visibleMedia()
        .map(({ id, name, etag }) => ({ id, name, etag }));
      harness.dispose();
      disposed = true;
      expectProjectMediaReleased(lifecycle);
      await harness.resolveDeferred(
        unselectedID,
        media(unselectedID, "late-after-disposal.mp4", "late"),
      );
      expect(lifecycle.listenerNotifications).toBe(notificationsBeforeDisposal);
      expect(lifecycle.notificationsAfterRelease).toBe(0);
      expect(controller.visibleMedia().map(({ id, name, etag }) => ({ id, name, etag }))).toEqual(
        beforeDispose,
      );
    } finally {
      if (!disposed) harness.dispose();
    }
  });
});
