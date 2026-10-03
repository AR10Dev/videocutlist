import type * as EffectApiTypes from "../src/generated/effect-api";
import { RegistryContext, RegistryProvider } from "@effect/atom-solid";
import { createComponent, createRoot, untrack, useContext } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceController,
  type WorkspaceController,
} from "../src/features/app/controller";
import { serializeProjectItem } from "../src/features/projects/model";

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

function until(check: () => boolean): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) resolve();
      else if (Date.now() - started > 5000)
        reject(new Error("Timed out waiting for workspace state."));
      else setTimeout(poll, 0);
    };
    poll();
  });
}

function mountWorkspace(options: {
  pageItems?: Media[];
  projects: Project[];
  currentMedia: (id: string, calls: number) => Media;
}) {
  const pending = new Map<string, Array<(response: Response) => void>>();
  const aborted = new Map<string, number>();
  const calls = new Map<string, number>();
  const deferredIDs = new Set<string>();
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
      return found ? Response.json(found) : new Response(null, { status: 404 });
    }
    const metadataPrefix = "/api/v2/media/";
    if (url.pathname.startsWith(metadataPrefix) && url.pathname !== `${metadataPrefix}tree`) {
      const id = decodeURIComponent(url.pathname.slice(metadataPrefix.length));
      const count = (calls.get(id) ?? 0) + 1;
      calls.set(id, count);
      if (deferredIDs.has(id))
        return new Promise<Response>((resolve) => {
          const queue = pending.get(id) ?? [];
          queue.push(resolve);
          pending.set(id, queue);
          init?.signal?.addEventListener(
            "abort",
            () => aborted.set(id, (aborted.get(id) ?? 0) + 1),
            { once: true },
          );
        });
      return Response.json(options.currentMedia(id, count));
    }
    return new Response(null, { status: 404 });
  });

  const browser = Object.assign(new EventTarget(), {
    location: new URL("https://example.test"),
    confirm: () => true,
  }) as unknown as Window;
  vi.stubGlobal("window", browser);
  vi.stubGlobal("localStorage", memoryStorage());
  let controller!: WorkspaceController;
  let dispose!: () => void;
  createRoot((rootDispose) => {
    dispose = rootDispose;
    createComponent(RegistryProvider, {
      get children() {
        untrack(() => {
          useContext(RegistryContext);
          controller = createWorkspaceController();
        });
        return null;
      },
    });
  });

  return {
    controller,
    dispose,
    calls,
    aborts: (id: string) => aborted.get(id) ?? 0,
    defer(id: string) {
      deferredIDs.add(id);
    },
    resolveDeferred(id: string, value: Media) {
      deferredIDs.delete(id);
      const queue = pending.get(id) ?? [];
      pending.delete(id);
      for (const resolve of queue) resolve(Response.json(value));
    },
    pendingCount: (id: string) => pending.get(id)?.length ?? 0,
  };
}

describe("workspace project media projection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps page-first ordering and canonical refresh separate from project/editor persistence", async () => {
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
      await until(() => controller.media().length === 2);
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

      controller.projects.scheduleAutosave = () => undefined;
      controller.updateTimeline({
        segments: [{ id: "s_projection-one", startMs: 100, endMs: 200 }],
      });
      controller.updateTimeline({
        segments: [
          { id: "s_projection-one", startMs: 100, endMs: 200 },
          { id: "s_projection-two", startMs: 300, endMs: 400 },
        ],
      });
      expect(controller.dirty()).toBe(true);
      const before = {
        items: controller.editableItems().map((item) => ({
          media: item.media,
          persisted: serializeProjectItem(item),
        })),
        timeline: controller.timeline(),
        revision: controller.revision(),
        dirty: controller.dirty(),
      };
      expect(controller.timeline().past).toHaveLength(2);

      refreshed = true;
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

      expect(controller.dirty()).toBe(before.dirty);
      expect(controller.revision()).toBe(before.revision);
      expect(
        controller.editableItems().map((item) => ({
          media: item.media,
          persisted: serializeProjectItem(item),
        })),
      ).toEqual(before.items);
      expect(controller.timeline()).toEqual(before.timeline);
      expect(controller.projectItems().find((item) => item.media.id === secondID)?.media.etag).toBe(
        "v1",
      );
      expect(controller.visibleMedia().find((item) => item.id === secondID)?.etag).toBe("v2");
    } finally {
      harness.dispose();
    }
  });

  it("detaches old metadata on project replacement and item removal", async () => {
    const oldID = mediaID("a");
    const nextID = mediaID("n");
    const removedID = mediaID("r");
    const oldProject = project(projectID("oldproject"), [oldID]);
    const replacement = project(projectID("newproject"), [nextID, removedID]);
    const harness = mountWorkspace({
      projects: [oldProject, replacement],
      currentMedia: (id) => media(id, `${id.slice(0, 5)}.mp4`),
    });
    const { controller } = harness;
    try {
      await controller.projects.loadProject(oldProject.id);
      harness.defer(oldID);
      controller.server.refreshMedia();
      await until(() => harness.pendingCount(oldID) > 0);
      await controller.projects.loadProject(replacement.id);
      await until(() => controller.visibleMedia().some((item) => item.id === removedID));
      harness.resolveDeferred(oldID, media(oldID, "late-replaced.mp4", "late"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controller.visibleMedia().map((item) => item.id)).toEqual([nextID, removedID]);
      expect(controller.visibleMedia().some((item) => item.name === "late-replaced.mp4")).toBe(
        false,
      );

      harness.defer(removedID);
      controller.server.refreshMedia();
      await until(() => harness.pendingCount(removedID) > 0);
      controller.removeProjectItem(itemID(2));
      await until(() => !controller.visibleMedia().some((item) => item.id === removedID));
      harness.resolveDeferred(removedID, media(removedID, "late-removed.mp4", "late"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controller.visibleMedia().map((item) => item.id)).toEqual([nextID]);
      expect(controller.dirty()).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it("disposes active project metadata subscriptions and ignores late completion", async () => {
    const sourceID = mediaID("d");
    const saved = project(projectID("disposedproject"), [sourceID]);
    const harness = mountWorkspace({
      projects: [saved],
      currentMedia: (id) => media(id, "original.mp4", "original-etag"),
    });
    const { controller } = harness;
    await controller.projects.loadProject(saved.id);
    harness.defer(sourceID);
    controller.server.refreshMedia();
    await until(() => harness.pendingCount(sourceID) > 0);
    const beforeDispose = controller
      .visibleMedia()
      .map(({ id, name, etag }) => ({ id, name, etag }));
    harness.dispose();
    expect(harness.aborts(sourceID)).toBeGreaterThan(0);
    harness.resolveDeferred(sourceID, media(sourceID, "late-after-disposal.mp4", "late"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.visibleMedia().map(({ id, name, etag }) => ({ id, name, etag }))).toEqual(
      beforeDispose,
    );
  });
});
