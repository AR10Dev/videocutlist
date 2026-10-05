import type * as EffectApiTypes from "../src/generated/effect-api";
import type * as Atom from "effect/reactivity/Atom";
import { RegistryContext, RegistryProvider } from "@effect/atom-solid";
import { createComponent, createRoot, untrack, useContext } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceController,
  type WorkspaceController,
} from "../src/features/app/controller";
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
}) {
  const pending = new Map<string, DeferredMetadataResponse[]>();
  const deferredIDs = new Set<string>();
  let saveRequests = 0;
  const projects = new Map(options.projects.map((entry) => [entry.id, entry]));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
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
      await until(() => controller.library.media().length === 2);
      await controller.projects.loadProject(saved.id);
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
      refreshed = true;
      controller.server.refreshMedia();
      await until(
        () => controller.visibleMedia().find((item) => item.id === secondID)?.etag === "v2",
      );
      expect(controller.dirty()).toBe(false);
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
      controller.chooseMedia(controller.visibleMedia().find((item) => item.id === thirdID)!);
      await until(
        () => controller.selected()?.id === thirdID && controller.selected()?.etag === "v2",
      );
      controller.chooseMedia(controller.visibleMedia().find((item) => item.id === secondID)!);
      await until(
        () => controller.selected()?.id === secondID && controller.selected()?.etag === "v2",
      );

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
    } finally {
      harness.dispose();
    }
  });

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
      await controller.projects.loadProject(oldProject.id);
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
      await controller.projects.loadProject(replacement.id);
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
      controller.removeProjectItem(itemID(2));
      await until(() => !controller.visibleMedia().some((item) => item.id === removedID));
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
      await controller.projects.loadProject(saved.id);
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
