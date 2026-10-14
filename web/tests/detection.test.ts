import type * as EffectApiTypes from "../src/generated/effect-api";
import { RegistryProvider, RegistryContext } from "@effect/atom-solid";
import { createComponent, createRoot, createSignal, untrack, useContext } from "solid-js";
import { withControllerTestRoot } from "./controllerTestEnvironment";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { Setter } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { editTimeline, createTimelineHistory, undoTimeline } from "../src/features/editor/timeline";
import {
  acceptCandidate,
  acceptCandidates,
  candidatePointMs,
  candidateSkipReason,
  skippedCandidateSummary,
  type Candidate,
} from "../src/features/detection/model";
import type { ApiClient, NativeMediaApiClient } from "../src/api";
import {
  createDetectionController,
  type DetectionController,
} from "../src/features/detection/controller";
import { createServerState } from "../src/app/server";
import { createProjectsController } from "../src/features/projects/controller";
import type { EditableProjectItem } from "../src/features/projects/model";
import { defaultSettings } from "../src/features/settings/model";

async function startDetection(
  controller: DetectionController,
  ...args: Parameters<DetectionController["startDetection"]>
) {
  controller.startDetection(...args);
  await vi.waitFor(() => expect(controller.startResult().waiting).toBe(false));
}
async function cancelDetection(controller: DetectionController) {
  controller.cancelDetection();
  await vi.waitFor(() => expect(controller.cancelResult().waiting).toBe(false));
}

function atomSignal<A>(registry: () => AtomRegistry.AtomRegistry, initial: A) {
  const atom = Atom.keepAlive(Atom.make(initial));
  const read = Object.assign(() => registry().get(atom), { atom });
  const set = ((input?: A | ((previous: A) => A)) => {
    const value =
      typeof input === "function" ? (input as (previous: A) => A)(read()) : (input as A);
    registry().set(atom, value);
    return value;
  }) as Setter<A>;
  return [read, set] as const;
}

const candidate = {
  id: "c_1",
  mediaId: "m_1",
  projectId: "p_1",
  projectRevision: 2,
  startMs: 10,
  endMs: 20,
  source: "silence" as const,
};
const point = {
  id: "c_point",
  mediaId: "m_1",
  projectId: "p_1",
  projectRevision: 2,
  pointMs: 50,
  source: "scene" as const,
};
const project = { id: "p_1", mediaId: "m_1", revision: 2, segments: [] };
const detectionMedia: EffectApiTypes.Media = {
  id: `m_${"m".repeat(43)}`,
  name: "detection.mp4",
  durationMs: 1_000,
  sizeBytes: 1,
  container: "mp4",
  streams: {},
  etag: "v1",
};
const queuedDetectionJob: EffectApiTypes.DetectionJob = {
  id: "j_012345678901",
  type: "detection",
  state: "queued",
  mediaId: detectionMedia.id,
  projectId: "p_000000000001",
  projectRevision: 1,
  kind: "silence",
};
const jobEvent = (job: EffectApiTypes.DetectionJob, revision = 1) => {
  const snapshot = {
    ...job,
    revision,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  return new Response(`id: ${revision}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
};
async function withDetection(
  api: ApiClient,
  exercise: (
    controller: DetectionController,
    state: {
      setRevision: (value: number) => void;
      setEditorVersion: (value: number) => void;
      setConflict: (value: boolean) => void;
      setMedia: (value: EffectApiTypes.Media) => void;
      setItem: (value: string) => void;
      undo: () => void;
      editorVersion: () => number;
      setProjectId: (value: string) => void;
      timeline: () => ReturnType<typeof createTimelineHistory>;
    },
  ) => Promise<void>,
  overrides: {
    selected?: () => EffectApiTypes.Media | undefined;
    activeItemId?: () => string | undefined;
    saveProject?: () => Promise<EffectApiTypes.Project | undefined>;
  } = {},
) {
  const configuration = {
    serverBaseUrl: "https://example.test",
    authentication: { type: "none" as const },
  };
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    return api.request(url.pathname.replace(/^\/api\/v2\//, "") + url.search, init);
  };
  await withControllerTestRoot(
    ({ registry }) => {
      const [revision, setRevision] = atomSignal(() => registry, 1);
      const [projectId, setProjectId] = atomSignal(() => registry, queuedDetectionJob.projectId);
      const [editorVersion, setEditorVersion] = atomSignal(() => registry, 0);
      const [reviewMedia, setMedia] = atomSignal(() => registry, detectionMedia);
      const [reviewItem, setItem] = atomSignal(() => registry, "i_detection");
      const [reviewConflict, setConflict] = atomSignal(() => registry, false);
      const [timeline, replaceTimeline] = atomSignal(
        () => registry,
        createTimelineHistory({ playheadMs: 0, segments: [], zoom: 1 }),
      );
      const controller = createDetectionController(
        createServerState({ ...api, mediaRequest: api.request }, registry, configuration),
        {
          reviewContext: Atom.make((get) => ({
            projectId: get(projectId.atom),
            revision: get(revision.atom),
            editorVersion: get(editorVersion.atom),
            selected: overrides.selected?.() ?? get(reviewMedia.atom),
            activeItemId: overrides.activeItemId?.() ?? get(reviewItem.atom),
            saveConflict: get(reviewConflict.atom),
          })),
          selected: overrides.selected ?? reviewMedia,
          activeItemId: overrides.activeItemId ?? reviewItem,
          projectId,
          revision,
          dirty: () => false,
          editorVersion,
          saveConflict: reviewConflict,
          segments: () => timeline().present.segments,
          saveProject: overrides.saveProject
            ? () => Effect.tryPromise(overrides.saveProject!)
            : () =>
                Effect.succeed({
                  id: projectId(),
                  revision: revision(),
                } as EffectApiTypes.Project),
          updateSegments: (value) => {
            replaceTimeline((current) => editTimeline(current, { segments: value }));
            setEditorVersion((version) => version + 1);
          },
        },
      );
      return {
        controller,
        state: {
          setRevision,
          editorVersion,
          setProjectId,
          timeline,
          setEditorVersion,
          setConflict,
          setMedia,
          setItem,
          undo: () => {
            replaceTimeline(undoTimeline(timeline()));
            setEditorVersion(editorVersion() + 1);
          },
        },
      };
    },
    ({ controller, state }) => exercise(controller, state),
    { configuration, fetch },
  );
}

async function withProjectSaveAndDetection(
  api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest">,
  exercise: (
    controller: DetectionController,
    context: {
      projectId: () => string;
      revision: () => number;
      dirty: () => boolean;
      saveConflict: () => boolean;
      saveProject: () => Promise<EffectApiTypes.Project | undefined>;
      setProjectId: (id: string) => void;
      selected: () => EffectApiTypes.Media | undefined;
      setSelected: (media: EffectApiTypes.Media) => void;
      activeItemId: () => string | undefined;
      setActiveItemId: (id: string) => void;
      setEditorVersion: (version: number) => void;
      setDirty: (dirty: boolean) => void;
      projectItems: () => EditableProjectItem[];
      setProjectItems: (items: EditableProjectItem[]) => void;
    },
  ) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  });
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return api.request(url.pathname.replace(/^\/api\/v2\//, "") + url.search, init);
  };
  const projectItemId = `i_${"d".repeat(24)}`;
  const item: EditableProjectItem = {
    id: projectItemId,
    media: detectionMedia,
    timeline: createTimelineHistory({ playheadMs: 0, inMs: 0, outMs: 0, segments: [], zoom: 1 }),
    muted: false,
    exportOptions: {
      mode: "merge",
      selection: "segments",
      cutStrategy: "stream_copy_preferred",
      container: "mkv",
    },
  };
  let registry!: ReturnType<typeof import("effect/reactivity/AtomRegistry").make>;
  let projects!: ReturnType<typeof createProjectsController>;
  let controller!: DetectionController;
  let context!: Parameters<typeof exercise>[1];
  let dispose!: () => void;
  createRoot((disposeRoot) => {
    dispose = disposeRoot;
    createComponent(RegistryProvider, {
      get children() {
        untrack(() => {
          registry = useContext(RegistryContext);
          const [selected, setSelected] = atomSignal<EffectApiTypes.Media | undefined>(
            () => registry,
            detectionMedia,
          );
          const [projectId, setProjectId] = atomSignal(
            () => registry,
            queuedDetectionJob.projectId,
          );
          const [projectName, setProjectName] = atomSignal(() => registry, "Detection project");
          const [revision, setRevision] = atomSignal(() => registry, 1);
          const [dirty, setDirty] = atomSignal(() => registry, true);
          const [editorVersion, setEditorVersion] = atomSignal(() => registry, 0);
          const [projectItems, setProjectItems] = atomSignal(() => registry, [item]);
          const [activeItemId, setActiveItemId] = atomSignal<string | undefined>(
            () => registry,
            projectItemId,
          );
          const [, setSelectedExportItems] = atomSignal<string[]>(() => registry, []);
          const [, replaceTimeline] = atomSignal(() => registry, item.timeline);
          const [, setMuted] = atomSignal(() => registry, false);
          const [, setStatus] = atomSignal(() => registry, "");
          const server = createServerState({ ...api, mediaRequest: api.request }, registry, {
            serverBaseUrl: "http://localhost",
            authentication: { type: "none" },
          });
          projects = createProjectsController({
            activeItemId,
            server,
            selected,
            projectId,
            projectName,
            revision,
            setRevision,
            dirty,
            setDirty,
            editorVersion,
            contextKey: () => "detection-test",
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
            clearDetectionContext: () => undefined,
            setDiagnostics: () => undefined,
            setStatus,
          });
          controller = createDetectionController(server, {
            reviewContext: Atom.make((get) => ({
              selected: get(selected.atom),
              activeItemId: get(activeItemId.atom),
              projectId: get(projectId.atom),
              revision: get(revision.atom),
              editorVersion: get(editorVersion.atom),
              saveConflict: get(projects.conflictAtom),
            })),
            selected,
            activeItemId,
            projectId,
            revision,
            dirty,
            editorVersion,
            saveConflict: projects.saveConflict,
            segments: () =>
              projectItems().find((entry) => entry.id === activeItemId())?.timeline.present
                .segments ?? [],
            saveProject: projects.saveProjectEffect,
            updateSegments: (segments) => {
              setProjectItems((items) =>
                items.map((entry) =>
                  entry.id === activeItemId()
                    ? {
                        ...entry,
                        timeline: {
                          ...entry.timeline,
                          present: { ...entry.timeline.present, segments },
                        },
                      }
                    : entry,
                ),
              );
              setEditorVersion((version) => version + 1);
            },
          });
          context = {
            projectId,
            revision,
            dirty,
            saveConflict: projects.saveConflict,
            saveProject: () =>
              Effect.runPromise(projects.saveProjectEffect()).catch(() => undefined),
            setProjectId,
            selected,
            setSelected,
            activeItemId,
            setActiveItemId,
            setEditorVersion,
            setDirty,
            projectItems,
            setProjectItems,
          };
        });
        return null;
      },
    });
  });
  try {
    await exercise(controller, context);
  } finally {
    projects.dispose();
    dispose();
    registry.dispose();
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

it("redelivers uncertain detection against the real project saver without an extra PUT", async () => {
  const puts: Array<{ target: string; revision: number }> = [];
  const submissions: Array<{ key: string | null; target: string; body: string }> = [];
  let acceptedJob: EffectApiTypes.DetectionJob | undefined;
  const api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest"> = {
    url: (path) => path,
    request: (path, init) => {
      if (init?.method === "PUT" && path.startsWith("projects/")) {
        const target = path.split("/")[1]!;
        const payload = JSON.parse(String(init.body)) as {
          revision: number;
          name: string;
          items: unknown[];
        };
        puts.push({ target, revision: payload.revision });
        return Promise.resolve(
          Response.json({
            id: target,
            revision: payload.revision + 1,
            updatedAt: "2026-01-01T00:00:00Z",
            schemaVersion: 2,
            name: payload.name,
            items: payload.items,
          }),
        );
      }
      if (path.endsWith("/detections") && init?.method === "POST") {
        const target = path.split("/")[1]!;
        submissions.push({
          key: new Headers(init.headers).get("Idempotency-Key"),
          target,
          body: String(init.body),
        });
        if (submissions.length === 1)
          return Promise.resolve(
            Response.json(
              { error: { code: "internal_error", message: "Retry", requestId: "r-lost" } },
              { status: 500 },
            ),
          );
        acceptedJob = {
          ...queuedDetectionJob,
          projectId: target,
          projectRevision: JSON.parse(String(init.body)).projectRevision,
        };
        return Promise.resolve(Response.json(acceptedJob, { status: 202 }));
      }
      if (path.endsWith("/events") && acceptedJob) return Promise.resolve(jobEvent(acceptedJob));
      return Promise.resolve(Response.json({}));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
    mediaRequest: () => Promise.reject(new Error("Unexpected media request")),
  };
  await withProjectSaveAndDetection(api, async (controller, context) => {
    await startDetection(controller, "silence", { noiseDb: -35 });
    expect(puts).toEqual([{ target: queuedDetectionJob.projectId, revision: 1 }]);
    const frozenAttempt = submissions[0];
    expect(frozenAttempt?.key).toBeTruthy();
    expect(JSON.parse(frozenAttempt!.body)).toMatchObject({
      mediaId: detectionMedia.id,
      projectItemId: `i_${"d".repeat(24)}`,
      projectRevision: 2,
      kind: "silence",
      noiseDb: -35,
    });

    await startDetection(controller, "silence", { noiseDb: -35 });
    expect(puts).toHaveLength(1);
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(frozenAttempt);
    expect(context.revision()).toBe(2);
    // A validated acknowledgement ends uncertainty; a later request is a new command.
    await startDetection(controller, "silence", { noiseDb: -35 });
    expect(puts).toHaveLength(2);
    expect(submissions).toHaveLength(3);
    expect(submissions[2].key).not.toBe(frozenAttempt!.key);
    expect(JSON.parse(submissions[2].body).projectRevision).toBe(3);
  });
});

it.each(["clear", "return", "revision", "options", "project"] as const)(
  "redelivers an interrupted detection after %s only when its saved intent is unchanged",
  async (change) => {
    const puts: Array<{ target: string; revision: number }> = [];
    const submissions: Array<{ key: string | null; target: string; body: string }> = [];
    const admitted = new Map<string, { body: string; job: EffectApiTypes.DetectionJob }>();
    let acknowledgeFirst!: (response: Response) => void;
    let firstSignal: AbortSignal | null | undefined;
    let acceptedJob: EffectApiTypes.DetectionJob | undefined;
    const api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest"> = {
      url: (path) => path,
      request: (path, init) => {
        if (init?.method === "PUT" && path.startsWith("projects/")) {
          const target = path.split("/")[1]!;
          const payload = JSON.parse(String(init.body)) as EffectApiTypes.ProjectInput;
          puts.push({ target, revision: payload.revision });
          return Promise.resolve(
            Response.json({
              ...payload,
              id: target,
              revision: payload.revision + 1,
              updatedAt: "2026-01-01T00:00:00Z",
            }),
          );
        }
        if (path.endsWith("/detections") && init?.method === "POST") {
          const target = path.split("/")[1]!;
          const body = String(init.body);
          const key = new Headers(init.headers).get("Idempotency-Key");
          submissions.push({ key, target, body });
          const identity = `${target}:${key}`;
          const previous = admitted.get(identity);
          if (previous) expect(body).toBe(previous.body);
          acceptedJob = previous?.job ?? {
            ...queuedDetectionJob,
            projectId: target,
            projectRevision: JSON.parse(body).projectRevision,
          };
          admitted.set(identity, { body, job: acceptedJob });
          if (submissions.length === 1) {
            firstSignal = init.signal;
            return new Promise((resolve) => {
              acknowledgeFirst = resolve;
            });
          }
          return Promise.resolve(Response.json(acceptedJob, { status: 202 }));
        }
        if (path.endsWith("/events") && acceptedJob) return Promise.resolve(jobEvent(acceptedJob));
        return Promise.resolve(Response.json({}));
      },
      assetRequest: () => Promise.resolve(Response.json({})),
      mediaRequest: () => Promise.reject(new Error("Unexpected media request")),
    };
    await withProjectSaveAndDetection(api, async (controller, context) => {
      controller.startDetection("silence", { noiseDb: -35 });
      await vi.waitFor(() => expect(submissions).toHaveLength(1));
      const first = submissions[0]!;
      expect(puts).toEqual([{ target: queuedDetectionJob.projectId, revision: 1 }]);
      expect(admitted.size).toBe(1);
      expect(controller.detectionStarting()).toBe(true);
      if (change === "return") context.setProjectId("p_000000000002");
      else controller.clearDetectionContext();
      await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true));
      expect(controller.detectionStarting()).toBe(false);
      controller.setDetectionStatus("new context review");
      acknowledgeFirst(Response.json(acceptedJob, { status: 202 }));
      await Promise.resolve();
      expect(controller.detectionJob()).toBeUndefined();
      expect(controller.detectionCandidates()).toEqual([]);
      expect(controller.detectionStatus()).toBe("new context review");
      if (change === "return") context.setProjectId(queuedDetectionJob.projectId);
      if (change === "revision") expect(await context.saveProject()).toBeTruthy();
      if (change === "project") context.setProjectId("p_000000000002");
      await startDetection(controller, "silence", { noiseDb: change === "options" ? -20 : -35 });
      expect(submissions).toHaveLength(2);
      if (change === "clear" || change === "return") {
        expect(submissions[1]).toEqual(first);
        expect(puts).toHaveLength(1);
        expect(admitted.size).toBe(1);
      } else {
        expect(submissions[1].key).not.toBe(first.key);
        expect(submissions[1].body).not.toBe(first.body);
        expect(puts).toHaveLength(change === "revision" ? 3 : 2);
        expect(admitted.size).toBe(2);
      }
      expect(controller.startResult()._tag).toBe("Success");
    });
  },
);

it("clears acknowledged detection identity even when its context no longer permits publication", async () => {
  let acknowledge!: (response: Response) => void;
  const [selected, setSelected] = createSignal(detectionMedia);
  const saveProject = vi.fn(() =>
    Promise.resolve({
      id: queuedDetectionJob.projectId,
      revision: 1,
    } as EffectApiTypes.Project),
  );
  const submissions: Array<{ key: string | null; body: string }> = [];
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) => {
      if (path.endsWith("/detections")) {
        submissions.push({
          key: new Headers(init?.headers).get("Idempotency-Key"),
          body: String(init?.body),
        });
        if (submissions.length === 1)
          return new Promise((resolve) => {
            acknowledge = resolve;
          });
        return Promise.resolve(Response.json(queuedDetectionJob, { status: 202 }));
      }
      return Promise.resolve(jobEvent(queuedDetectionJob));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(
    api,
    async (controller) => {
      controller.startDetection("silence");
      await vi.waitFor(() => expect(submissions).toHaveLength(1));
      // An untracked fixture change exercises the final context guard, not the interrupt watch.
      setSelected({ ...detectionMedia, etag: "new-source" });
      controller.setDetectionStatus("new context review");
      acknowledge(Response.json(queuedDetectionJob, { status: 202 }));
      await vi.waitFor(() => expect(controller.startResult()._tag).toBe("Success"));
      expect(controller.detectionJob()).toBeUndefined();
      expect(controller.detectionCandidates()).toEqual([]);
      expect(controller.detectionStatus()).toBe("new context review");
      setSelected(detectionMedia);
      await startDetection(controller, "silence");
      expect(submissions[1].body).toBe(submissions[0].body);
      expect(submissions[1].key).not.toBe(submissions[0].key);
      expect(saveProject).toHaveBeenCalledTimes(2);
    },
    { selected, saveProject },
  );
});

it.each([
  "project",
  "media",
  "source",
  "item",
  "editor",
  "options",
  "kind",
  "revision",
  "conflict",
  "dirty",
] as const)("saves changed %s detection intent before assigning a fresh key", async (change) => {
  const puts: Array<{ target: string; revision: number }> = [];
  const submissions: Array<{ key: string | null; target: string; body: string }> = [];
  let acceptedJob: EffectApiTypes.DetectionJob | undefined;
  let conflictNextPut = false;
  const api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest"> = {
    url: (path) => path,
    request: (path, init) => {
      if (init?.method === "PUT" && path.startsWith("projects/")) {
        const target = path.split("/")[1]!;
        const payload = JSON.parse(String(init.body)) as {
          revision: number;
          name: string;
          items: unknown[];
        };
        puts.push({ target, revision: payload.revision });
        if (conflictNextPut) {
          conflictNextPut = false;
          return Promise.resolve(
            Response.json(
              {
                error: { code: "revision_conflict", message: "Conflict", requestId: "r-conflict" },
              },
              { status: 409 },
            ),
          );
        }
        return Promise.resolve(
          Response.json({
            id: target,
            revision: payload.revision + 1,
            updatedAt: "2026-01-01T00:00:00Z",
            schemaVersion: 2,
            name: payload.name,
            items: payload.items,
          }),
        );
      }
      if (path.endsWith("/detections") && init?.method === "POST") {
        const target = path.split("/")[1]!;
        const body = String(init.body);
        submissions.push({ key: new Headers(init.headers).get("Idempotency-Key"), target, body });
        if (submissions.length === 1)
          return Promise.resolve(
            Response.json(
              { error: { code: "internal_error", message: "Retry", requestId: "r-lost" } },
              { status: 500 },
            ),
          );
        acceptedJob = {
          ...queuedDetectionJob,
          projectId: target,
          projectRevision: JSON.parse(body).projectRevision,
        };
        return Promise.resolve(Response.json(acceptedJob, { status: 202 }));
      }
      if (path.endsWith("/events") && acceptedJob) return Promise.resolve(jobEvent(acceptedJob));
      return Promise.resolve(Response.json({}));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
    mediaRequest: () => Promise.reject(new Error("Unexpected media request")),
  };
  await withProjectSaveAndDetection(api, async (controller, context) => {
    await startDetection(controller, "silence", { noiseDb: -35 });
    const first = submissions[0]!;
    if (change === "project") context.setProjectId("p_000000000002");
    if (change === "media" || change === "source") {
      const changedMedia = {
        ...detectionMedia,
        ...(change === "media" ? { id: `m_${"n".repeat(43)}` } : { etag: "v2" }),
      };
      context.setSelected(changedMedia);
      context.setProjectItems(
        context.projectItems().map((entry) => ({ ...entry, media: changedMedia })),
      );
    }
    if (change === "item") {
      const newItem: EditableProjectItem = {
        ...context.projectItems()[0]!,
        id: `i_${"e".repeat(24)}`,
      };
      context.setProjectItems([...context.projectItems(), newItem]);
      context.setActiveItemId(newItem.id);
    }
    if (change === "editor") context.setEditorVersion(1);
    if (change === "revision") {
      expect(await context.saveProject()).toBeTruthy();
      expect(context.revision()).toBe(3);
    }
    if (change === "conflict") {
      conflictNextPut = true;
      expect(await context.saveProject()).toBeUndefined();
      expect(context.saveConflict()).toBe(true);
    }
    if (change === "dirty") context.setDirty(true);
    expect(context.dirty()).toBe(change === "dirty");
    expect(context.saveConflict()).toBe(change === "conflict");
    expect(context.revision()).toBe(change === "revision" ? 3 : 2);
    const kind = change === "kind" ? "black" : "silence";
    await startDetection(controller, kind, { noiseDb: change === "options" ? -20 : -35 });
    expect(puts).toHaveLength(change === "revision" || change === "conflict" ? 3 : 2);
    expect(puts[1]?.revision).toBe(2);
    expect(submissions).toHaveLength(2);
    expect(submissions[1]?.key).toBeTruthy();
    expect(submissions[1]?.key).not.toBe(first.key);
    expect(submissions[1]?.body).not.toBe(first.body);
    if (change === "project") {
      expect(puts[1]?.target).toBe("p_000000000002");
      expect(submissions[1]?.target).toBe("p_000000000002");
    }
  });
});

it("uses a fresh key after generated detection capacity rejection", async () => {
  const submissions: Array<{ key: string | null; target: string; body: string }> = [];
  let acceptedJob: EffectApiTypes.DetectionJob | undefined;
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) => {
      if (path.endsWith("/detections") && init?.method === "POST") {
        submissions.push({
          key: new Headers(init.headers).get("Idempotency-Key"),
          target: path.split("/")[1]!,
          body: String(init.body),
        });
        if (submissions.length === 1)
          return Promise.resolve(
            Response.json(
              {
                error: {
                  code: "detection_busy",
                  message: "Detection capacity is full.",
                  requestId: "r-detection-busy",
                },
              },
              { status: 429 },
            ),
          );
        acceptedJob = queuedDetectionJob;
        return Promise.resolve(Response.json(acceptedJob, { status: 202 }));
      }
      if (path.endsWith("/events") && acceptedJob) return Promise.resolve(jobEvent(acceptedJob));
      return Promise.resolve(Response.json({}));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller) => {
    await startDetection(controller, "silence", { noiseDb: -35 });
    expect(controller.detectionStatus()).toBe("Detection capacity is busy. Try again shortly.");
    await startDetection(controller, "silence", { noiseDb: -35 });
    expect(submissions).toHaveLength(2);
    expect(submissions[1].target).toBe(submissions[0].target);
    expect(submissions[1].body).toBe(submissions[0].body);
    expect(submissions[0].key).toBeTruthy();
    expect(submissions[1].key).toBeTruthy();
    expect(submissions[1].key).not.toBe(submissions[0].key);
  });
});

it("uses a fresh key for an uncertain identical command sent to another project", async () => {
  const secondProjectId = "p_000000000002";
  const submissions: Array<{ key: string | null; target: string; body: string }> = [];
  let acceptedJob: EffectApiTypes.DetectionJob | undefined;
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) => {
      if (path.endsWith("/detections") && init?.method === "POST") {
        const target = path.split("/")[1]!;
        submissions.push({
          key: new Headers(init.headers).get("Idempotency-Key"),
          target,
          body: String(init.body),
        });
        if (submissions.length === 1)
          return Promise.resolve(
            Response.json(
              { error: { code: "internal_error", message: "Retry", requestId: "r1" } },
              { status: 500 },
            ),
          );
        acceptedJob = { ...queuedDetectionJob, projectId: target };
        return Promise.resolve(Response.json(acceptedJob, { status: 202 }));
      }
      if (path.endsWith("/events") && acceptedJob) return Promise.resolve(jobEvent(acceptedJob));
      return Promise.resolve(Response.json({}));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller, { setProjectId }) => {
    await startDetection(controller, "silence", { noiseDb: -35 });
    setProjectId(secondProjectId);
    await startDetection(controller, "silence", { noiseDb: -35 });
    expect(submissions).toHaveLength(2);
    expect(submissions.map(({ target }) => target)).toEqual([
      queuedDetectionJob.projectId,
      secondProjectId,
    ]);
    expect(submissions[0].body).toBe(submissions[1].body);
    expect(submissions[0].key).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(submissions[1].key).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(submissions[1].key).not.toBe(submissions[0].key);
  });
});

it("preserves a local detection cancellation over stale status responses", async () => {
  let releaseDelete!: (response: Response) => void;
  let releaseStatus!: (response: Response) => void;
  let markDeleteStarted!: () => void;
  let markStatusStarted!: () => void;
  const deleteStarted = new Promise<void>((resolve) => {
    markDeleteStarted = resolve;
  });
  const statusStarted = new Promise<void>((resolve) => {
    markStatusStarted = resolve;
  });
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) => {
      if (path === `jobs/${queuedDetectionJob.id}` && init?.method === "DELETE") {
        return new Promise<Response>((resolve) => {
          releaseDelete = resolve;
          markDeleteStarted();
        });
      }
      if (path.startsWith("projects/") && init?.method === "POST")
        return Promise.resolve(Response.json(queuedDetectionJob, { status: 202 }));
      if (path === `jobs/${queuedDetectionJob.id}/events`) {
        return new Promise<Response>((resolve) => {
          releaseStatus = resolve;
          markStatusStarted();
        });
      }
      return Promise.resolve(Response.json({}));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller) => {
    await startDetection(controller, "silence");
    await statusStarted;
    const cancellation = cancelDetection(controller);
    const cancellationProgress = await Promise.race([
      deleteStarted.then(() => "delete"),
      cancellation.then(() => "done"),
    ]);
    expect(cancellationProgress, controller.detectionStatus()).toBe("delete");
    releaseStatus(jobEvent(queuedDetectionJob));
    releaseDelete(new Response(null, { status: 204 }));
    await cancellation;
    expect(controller.detectionJob()).toBeUndefined();
    expect(controller.detectionStatus()).toBe("Detection cancellation requested.");
  });
});

it("clears optimistic cancellation when the delete fails", async () => {
  let eventRequests = 0;
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) => {
      if (path.endsWith("/detections") && init?.method === "POST")
        return Promise.resolve(Response.json(queuedDetectionJob, { status: 202 }));
      if (path.endsWith("/events")) {
        eventRequests++;
        return Promise.resolve(
          eventRequests === 1 ? jobEvent(queuedDetectionJob) : new Response(null, { status: 503 }),
        );
      }
      if (path === `jobs/${queuedDetectionJob.id}` && init?.method === "DELETE")
        return Promise.resolve(
          Response.json(
            { error: { code: "unavailable", message: "Delete unavailable", requestId: "r1" } },
            { status: 503 },
          ),
        );
      return Promise.resolve(Response.json({}));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller) => {
    await startDetection(controller, "silence");
    await vi.waitFor(() => expect(controller.detectionJob()?.state).toBe("queued"));
    await cancelDetection(controller);
    expect(controller.detectionJob()?.state).toBe("queued");
    expect(controller.detectionStatus()).not.toBe("Detection cancellation requested.");
  });
});

it.each([true, false])(
  "keeps a terminal SSE result before a %s cancellation acknowledgement",
  async (success) => {
    let releaseDelete!: (response: Response) => void;
    let releaseStatus!: (response: Response) => void;
    let markDeleteStarted!: () => void;
    let markStatusStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });
    const statusStarted = new Promise<void>((resolve) => {
      markStatusStarted = resolve;
    });
    const resultCandidate = {
      id: "c_terminal",
      mediaId: detectionMedia.id,
      projectId: queuedDetectionJob.projectId,
      projectRevision: 1,
      startMs: 25,
      endMs: 35,
      source: "silence" as const,
    };
    const api: ApiClient = {
      url: (path) => path,
      request: (path, init) => {
        if (path === `jobs/${queuedDetectionJob.id}` && init?.method === "DELETE")
          return new Promise<Response>((resolve) => {
            releaseDelete = resolve;
            markDeleteStarted();
          });
        if (path.startsWith("projects/") && init?.method === "POST")
          return Promise.resolve(Response.json(queuedDetectionJob, { status: 202 }));
        if (path === `jobs/${queuedDetectionJob.id}/events`)
          return new Promise<Response>((resolve) => {
            releaseStatus = resolve;
            markStatusStarted();
          });
        return Promise.resolve(Response.json({}));
      },
      assetRequest: () => Promise.resolve(Response.json({})),
    };
    await withDetection(api, async (controller) => {
      await startDetection(controller, "silence");
      await statusStarted;
      const cancellation = cancelDetection(controller);
      await deleteStarted;
      releaseStatus(
        jobEvent({ ...queuedDetectionJob, state: "succeeded", candidates: [resultCandidate] }),
      );
      await vi.waitFor(() => expect(controller.detectionJob()?.state).toBe("succeeded"));
      releaseDelete(
        success
          ? new Response(null, { status: 204 })
          : Response.json(
              { error: { code: "internal_error", message: "Delete unavailable", requestId: "r1" } },
              { status: 500 },
            ),
      );
      await cancellation;
      expect(controller.detectionJob()?.state).toBe("succeeded");
      expect(controller.detectionCandidates()).toEqual([resultCandidate]);
      expect(controller.detectionStatus()).toContain("candidates found");
    });
  },
);

it("accepts successive candidates across its own saved revisions but rejects external changes", async () => {
  const candidates = [10, 30, 50, 70].map((startMs, index) => ({
    id: `c_review_${index}`,
    mediaId: detectionMedia.id,
    projectId: queuedDetectionJob.projectId,
    projectRevision: 1,
    startMs,
    endMs: startMs + 5,
    source: "silence" as const,
  }));
  const completed = { ...queuedDetectionJob, state: "succeeded" as const, candidates };
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) =>
      path.endsWith("/detections") && init?.method === "POST"
        ? Promise.resolve(Response.json(queuedDetectionJob, { status: 202 }))
        : Promise.resolve(jobEvent(completed, 2)),
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller, { setRevision, editorVersion }) => {
    await startDetection(controller, "silence");
    await vi.waitFor(() => expect(controller.detectionJob()?.state).toBe("succeeded"));
    expect(controller.acceptDetection(candidates[0]).accepted).toHaveLength(1);
    expect(editorVersion()).toBe(1);
    setRevision(2);
    expect(controller.acceptDetection(candidates[1]).accepted).toHaveLength(1);
    expect(editorVersion()).toBe(2);
    setRevision(3);
    expect(controller.acceptDetection(candidates[2]).accepted).toHaveLength(1);
    setRevision(5);
    expect(controller.acceptDetection(candidates[3]).accepted).toHaveLength(0);
  });
});

it("does not resurrect accepted or dismissed IDs from a repeated result, even after undo", async () => {
  const candidates = [10, 30, 50].map((startMs, index) => ({
    ...candidate,
    id: `c_once_${index}`,
    mediaId: detectionMedia.id,
    projectId: queuedDetectionJob.projectId,
    projectRevision: 1,
    startMs,
    endMs: startMs + 5,
  }));
  const api: ApiClient = {
    url: (path) => path,
    request: () => Promise.resolve(Response.json({})),
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller, context) => {
    controller.setDetectionCandidates(candidates);
    expect(controller.acceptDetection(candidates[0]).accepted).toHaveLength(1);
    controller.rejectDetection(candidates[1]);
    controller.setDetectionCandidates(candidates);
    expect(controller.detectionCandidates()).toEqual([candidates[2]]);
    context.undo();
    expect(controller.acceptDetection(candidates[0]).accepted).toEqual([]);
    expect(controller.acceptDetection(candidates[1]).accepted).toEqual([]);
    expect(controller.bulkAcceptDetection().accepted).toEqual([candidates[2]]);
    controller.setDetectionCandidates(candidates);
    expect(controller.detectionCandidates()).toEqual([]);
    controller.clearDetectionContext();
    controller.setDetectionCandidates(candidates);
    expect(controller.detectionCandidates()).toEqual(candidates);
  });
});

it.each(["editor", "conflict", "fingerprint", "item", "project"] as const)(
  "invalidates review after unrelated %s changes, including after an accepted edit",
  async (change) => {
    const candidates = [10, 30].map((startMs, index) => ({
      ...candidate,
      id: `c_invalidated_${index}`,
      mediaId: detectionMedia.id,
      projectId: queuedDetectionJob.projectId,
      projectRevision: 1,
      startMs,
      endMs: startMs + 5,
    }));
    const api: ApiClient = {
      url: (path) => path,
      request: (path, init) =>
        Promise.resolve(
          path.endsWith("/detections") && init?.method === "POST"
            ? Response.json(queuedDetectionJob, { status: 202 })
            : jobEvent({ ...queuedDetectionJob, state: "succeeded", candidates }, 2),
        ),
      assetRequest: () => Promise.resolve(Response.json({})),
    };
    await withDetection(api, async (controller, context) => {
      await startDetection(controller, "silence");
      await vi.waitFor(() => expect(controller.detectionCandidates()).toHaveLength(2));
      expect(controller.acceptDetection(candidates[0]).accepted).toHaveLength(1);
      if (change === "editor") context.setEditorVersion(context.editorVersion() + 1);
      if (change === "conflict") context.setConflict(true);
      if (change === "fingerprint") context.setMedia({ ...detectionMedia, etag: "new-source" });
      if (change === "item") context.setItem("i_other");
      if (change === "project") context.setProjectId("p_000000000002");
      context.setRevision(2);
      expect(controller.acceptDetection(candidates[1]).skipped[0]?.reason).toBe("stale");
      expect(controller.detectionStatus()).toBe(
        "Candidate is stale, invalid, or overlaps an existing segment.",
      );
      expect(context.timeline().past).toHaveLength(1);
      expect(undoTimeline(context.timeline()).present.segments).toEqual([]);
    });
  },
);

it("does not submit detection when the source changes during the required save", async () => {
  let completeSave!: (project: EffectApiTypes.Project) => void;
  const saveProject = () =>
    new Promise<EffectApiTypes.Project>((resolve) => {
      completeSave = resolve;
    });
  const [selected, setSelected] = createSignal(detectionMedia);
  let submitted = false;
  const api: ApiClient = {
    url: (path) => path,
    request: () => {
      submitted = true;
      return Promise.resolve(Response.json(queuedDetectionJob));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(
    api,
    async (controller) => {
      const start = startDetection(controller, "silence");
      expect(controller.detectionStatus()).toBe("Saving project before detection…");
      expect(submitted).toBe(false);
      setSelected({ ...detectionMedia, etag: "updated" });
      completeSave({
        id: queuedDetectionJob.projectId,
        revision: 1,
      } as EffectApiTypes.Project);
      await start;
      expect(submitted).toBe(false);
      expect(controller.detectionJob()).toBeUndefined();
      expect(controller.detectionStatus()).toBe("Detection is stale; save or reload the project.");
    },
    { selected, saveProject },
  );
});

it("reconnects after a transient status failure and offers completed candidates for review", async () => {
  const candidate = {
    id: "c_recovered",
    mediaId: detectionMedia.id,
    projectId: queuedDetectionJob.projectId,
    projectRevision: 1,
    startMs: 100,
    endMs: 125,
    source: "silence" as const,
  };
  let requests = 0;
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) => {
      if (path.endsWith("/detections") && init?.method === "POST")
        return Promise.resolve(Response.json(queuedDetectionJob, { status: 202 }));
      requests++;
      return Promise.resolve(
        requests === 1
          ? Response.json(
              { error: { code: "unavailable", message: "Status unavailable", requestId: "r1" } },
              { status: 503 },
            )
          : jobEvent({ ...queuedDetectionJob, state: "succeeded", candidates: [candidate] }, 2),
      );
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller) => {
    await startDetection(controller, "silence");
    await vi.waitFor(() => expect(controller.detectionJob()?.state).toBe("succeeded"), {
      timeout: 2_000,
    });
    expect(requests).toBe(2);
    expect(controller.detectionCandidates()).toEqual([candidate]);
    expect(controller.detectionQueryError()).toBe("");
    expect(controller.acceptDetection(candidate).accepted).toHaveLength(1);
  });
});

it("rejects completed candidates after changing the active project item", async () => {
  const candidate = {
    id: "c_other_item",
    mediaId: detectionMedia.id,
    projectId: queuedDetectionJob.projectId,
    projectRevision: 1,
    startMs: 180,
    endMs: 190,
    source: "silence" as const,
  };
  let completeStatus!: (response: Response) => void;
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) =>
      path.startsWith("projects/") && init?.method === "POST"
        ? Promise.resolve(Response.json(queuedDetectionJob, { status: 202 }))
        : new Promise<Response>((resolve) => {
            completeStatus = resolve;
          }),
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller, context) => {
    await startDetection(controller, "silence");
    await vi.waitFor(() => expect(completeStatus).toBeTypeOf("function"));
    context.setItem("i_other");
    completeStatus(
      jobEvent({ ...queuedDetectionJob, state: "succeeded", candidates: [candidate] }, 2),
    );
    await vi.waitFor(() => expect(controller.detectionJob()?.state).toBe("succeeded"));
    expect(controller.acceptDetection(candidate).skipped[0]?.reason).toBe("stale");
  });
});

it("keeps save failure in the native outcome without submitting", async () => {
  const request = vi.fn(() => Promise.resolve(Response.json({})));
  await withDetection(
    { url: (path) => path, request, assetRequest: request },
    async (controller) => {
      await startDetection(controller, "silence");
      expect(controller.startResult()._tag).toBe("Failure");
      expect(controller.detectionStarting()).toBe(false);
      expect(controller.detectionStatus()).toContain("Detection was not started.");
      expect(controller.detectionJob()).toBeUndefined();
      expect(request).not.toHaveBeenCalled();
    },
    { saveProject: () => Promise.reject(new Error("private save failure")) },
  );
});

it.each(["save", "submit", "revision"] as const)(
  "interrupts client %s on context switch without cancelling the server job",
  async (phase) => {
    let release!: (value: EffectApiTypes.Project) => void;
    let releaseSubmit!: (response: Response) => void;
    let submitSignal: AbortSignal | null | undefined;
    const calls: string[] = [];
    const api: ApiClient = {
      url: (path) => path,
      request: (path, init) => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path.endsWith("/detections")) {
          submitSignal = init?.signal;
          return new Promise((resolve) => {
            releaseSubmit = resolve;
          });
        }
        return Promise.resolve(jobEvent(queuedDetectionJob));
      },
      assetRequest: () => Promise.resolve(Response.json({})),
    };
    await withDetection(
      api,
      async (controller, context) => {
        controller.startDetection("silence");
        expect(controller.detectionStarting()).toBe(true);
        if (phase !== "save") await vi.waitFor(() => expect(releaseSubmit).toBeTypeOf("function"));
        if (phase === "revision") context.setRevision(2);
        else context.setProjectId("p_000000000002");
        await vi.waitFor(() => expect(controller.detectionStarting()).toBe(false));
        controller.setDetectionStatus("new context review");
        if (phase === "save")
          release({ id: queuedDetectionJob.projectId, revision: 1 } as EffectApiTypes.Project);
        else {
          expect(submitSignal?.aborted).toBe(true);
          releaseSubmit(Response.json(queuedDetectionJob, { status: 202 }));
        }
        await Promise.resolve();
        expect(controller.detectionJob()).toBeUndefined();
        expect(controller.detectionStatus()).toBe("new context review");
        expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
        expect(calls.some((call) => call.includes("/events"))).toBe(false);
        if (phase === "save") expect(calls).toEqual([]);
      },
      phase === "save"
        ? {
            saveProject: () =>
              new Promise((resolve) => {
                release = resolve;
              }),
          }
        : {},
    );
  },
);

it("clearing context releases review observation, not the durable job", async () => {
  let releaseSnapshot!: (response: Response) => void;
  const calls: string[] = [];
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/detections"))
        return Promise.resolve(Response.json(queuedDetectionJob, { status: 202 }));
      return new Promise((resolve) => {
        releaseSnapshot = resolve;
      });
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller) => {
    await startDetection(controller, "silence");
    await vi.waitFor(() => expect(releaseSnapshot).toBeTypeOf("function"));
    controller.clearDetectionContext();
    controller.setDetectionStatus("new context");
    releaseSnapshot(jobEvent({ ...queuedDetectionJob, state: "succeeded", candidates: [] }, 2));
    await Promise.resolve();
    expect(controller.detectionJob()).toBeUndefined();
    expect(controller.detectionCandidates()).toEqual([]);
    expect(controller.detectionStatus()).toBe("new context");
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  });
});

it("keeps advanced options in their atom and rejects invalid input before HTTP", async () => {
  const request = vi.fn(() => Promise.resolve(Response.json({})));
  await withDetection(
    { url: (path) => path, request, assetRequest: request },
    async (controller) => {
      controller.setDetectionOptions({ sceneThreshold: 5 });
      controller.clearDetectionContext();
      expect(controller.detectionOptions()).toEqual({ sceneThreshold: 5 });
      await startDetection(controller, "scene");
      expect(controller.startResult()._tag).toBe("Failure");
      expect(controller.detectionStatus()).toBe(
        "Detection settings were rejected. Check the sensitivity values.",
      );
      expect(request).not.toHaveBeenCalled();
      controller.setDetectionOptions((current) => ({ ...current, sceneThreshold: 0.25 }));
      expect(controller.detectionOptions()).toEqual({ sceneThreshold: 0.25 });
    },
  );
});

describe("candidate acceptance", () => {
  it("adds only a current, non-overlapping range candidate", () =>
    expect(acceptCandidate(candidate, project, 100)?.segments).toEqual([
      { startMs: 10, endMs: 20, label: "silence", included: true },
    ]));

  it("reports stale, invalid, overlapping, and point candidates", () => {
    const result = acceptCandidates(
      [
        candidate,
        { ...candidate, id: "c_overlap", startMs: 15, endMs: 25 },
        { ...candidate, id: "c_stale", projectRevision: 1 },
        { ...candidate, id: "c_invalid", startMs: 90, endMs: 110 },
        point,
      ],
      project,
      100,
    );
    expect(result.accepted.map((item) => item.id)).toEqual(["c_1"]);
    expect(result.skipped.map((item) => [item.candidate.id, item.reason])).toEqual([
      ["c_overlap", "overlap"],
      ["c_stale", "stale"],
      ["c_invalid", "invalid"],
      ["c_point", "point"],
    ]);
    expect(skippedCandidateSummary(result.skipped)).toBe(
      "1 stale, 1 invalid, 1 overlapping, 1 scene points",
    );
    expect(candidateSkipReason({ ...candidate, endMs: 101 }, project, 100)).toBe("invalid");
  });

  it("keeps scene points review-only and supports legacy one-millisecond results", () => {
    expect(acceptCandidate(point, project, 100)).toBeNull();
    const legacy = {
      ...point,
      pointMs: undefined,
      startMs: 50,
      endMs: 51,
    } as unknown as Candidate;
    expect(candidatePointMs(legacy)).toBe(50);
    expect(candidateSkipReason(legacy, project, 100)).toBe("point");
    expect(candidateSkipReason({ ...point, pointMs: -1 }, project, 100)).toBe("invalid");
    expect(candidateSkipReason({ ...point, pointMs: 101 }, project, 100)).toBe("invalid");
  });

  it("publishes a bulk result as one undoable timeline edit", async () => {
    const firstCandidate = {
      ...candidate,
      mediaId: detectionMedia.id,
      projectId: queuedDetectionJob.projectId,
      projectRevision: 1,
    };
    const candidates = [firstCandidate, { ...firstCandidate, id: "c_2", startMs: 30, endMs: 40 }];
    await withDetection(
      {
        url: (path) => path,
        request: () => Promise.resolve(Response.json({})),
        assetRequest: () => Promise.resolve(Response.json({})),
      },
      async (controller, { timeline }) => {
        controller.setDetectionCandidates(candidates);
        const result = controller.bulkAcceptDetection();
        expect(result.accepted.map((item) => item.id)).toEqual(["c_1", "c_2"]);
        expect(timeline().present.segments).toHaveLength(2);
        expect(timeline().past).toHaveLength(1);
        expect(undoTimeline(timeline()).present.segments).toEqual([]);
      },
    );
  });

  it("rejects stale and overlapping candidates without mutation", () => {
    const staleCandidate = Object.freeze({ ...candidate, projectRevision: 1 });
    const staleProject = Object.freeze({ ...project, segments: [] });
    const staleProjectBefore = structuredClone(staleProject);
    expect(acceptCandidate(staleCandidate, staleProject, 100)).toBeNull();
    expect(staleCandidate).toEqual({ ...candidate, projectRevision: 1 });
    expect(staleProject).toEqual(staleProjectBefore);

    const overlappingCandidate = Object.freeze({ ...candidate, startMs: 15 });
    const existingSegment = Object.freeze({ startMs: 12, endMs: 18, included: true });
    const overlapProject = Object.freeze({ ...project, segments: [existingSegment] });
    const overlapProjectBefore = structuredClone(overlapProject);
    expect(acceptCandidate(overlappingCandidate, overlapProject, 100)).toBeNull();
    expect(overlappingCandidate).toEqual({ ...candidate, startMs: 15 });
    expect(overlapProject).toEqual(overlapProjectBefore);
  });
});
