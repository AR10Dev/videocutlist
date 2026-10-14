import type * as EffectApiTypes from "../src/generated/effect-api";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtomValue } from "@effect/atom-solid";
import { Effect } from "effect";
import { createControllerTestRoot } from "./controllerTestEnvironment";
import { untrack } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, NativeMediaApiClient } from "../src/api";
import { createServerState } from "../src/app/server";
import { createExportController } from "../src/features/export/controller";
import { createTimelineHistory } from "../src/features/editor/timeline";
import type { EditableProjectItem } from "../src/features/projects/model";
import { defaultBrowserPreferences } from "../src/features/settings/model";
import { memoryStorage } from "./memoryStorage";

const batchId = "b_exportstatus0001";
const timestamp = "2026-01-01T00:00:00Z";
const media: EffectApiTypes.Media = {
  id: `m_${"m".repeat(43)}`,
  name: "clip.mp4",
  durationMs: 2_000,
  sizeBytes: 1,
  container: "mp4",
  streams: {},
  etag: "v1",
};

type Batch = EffectApiTypes.Batch;
type Job = EffectApiTypes.Job;
type ExportController = ReturnType<typeof createExportController>;
const exportRegistries = new WeakMap<ExportController, AtomRegistry.AtomRegistry>();
const submitExport = (controller: ExportController) => {
  controller.exportProject();
  return Effect.runPromise(
    AtomRegistry.getResult(exportRegistries.get(controller)!, controller.exportCommand, {
      suspendOnWaiting: true,
    }).pipe(Effect.exit),
  );
};

const retryChild = (controller: ExportController, id: string, batchId?: string) => {
  controller.retryChildJob(id, batchId);
  return Effect.runPromise(
    AtomRegistry.getResult(exportRegistries.get(controller)!, controller.retryCommands(id), {
      suspendOnWaiting: true,
    }).pipe(Effect.exit),
  );
};

type PreflightContext = Atom.Type<Parameters<typeof createExportController>[0]["preflightContext"]>;

const job = (id: string, state: Job["state"], revision: number, errorCode?: string): Job => ({
  id,
  batchId,
  type: "export",
  state,
  revision,
  progress: state === "succeeded" ? 1 : 0.5,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...(errorCode ? { errorCode } : {}),
});

const batch = (state: Batch["state"], progress: number, jobs: Job[]): Batch => ({
  batchId,
  projectId: "p_exportstatus0001",
  projectRevision: 1,
  state,
  progress,
  jobs,
});
const exportItem = (media: EffectApiTypes.Media): EditableProjectItem => ({
  id: `i_${"i".repeat(24)}`,
  media,
  timeline: createTimelineHistory({
    playheadMs: 0,
    inMs: 0,
    outMs: 1_000,
    segments: [{ id: "s_exportfresh0001", startMs: 0, endMs: 1_000 }],
    zoom: 1,
  }),
  muted: false,
  exportOptions: {
    mode: "merge",
    selection: "segments",
    cutStrategy: "stream_copy_preferred",
    container: "mkv",
  },
});

async function withExportController(
  terminalBatch: Batch,
  exercise: (
    controller: ExportController,
    controls: {
      items: () => EditableProjectItem[];
      replaceItems: (items: EditableProjectItem[]) => void;
      activate: (id: string) => void;
      preferences: Partial<typeof defaultBrowserPreferences>[];
      dirtyCount: () => number;
      refreshOptions: () => void;
      updateContext: (context: Partial<PreflightContext>) => void;
      setNotice: (status: string) => void;
      registry: AtomRegistry.AtomRegistry;
      server: ReturnType<typeof createServerState>;
      refreshMedia: () => void;
      dispose: () => void;
    },
  ) => Promise<void>,
  options: {
    initialBatch?: Batch;
    selected?: EffectApiTypes.Media;
    projectId?: () => string;
    editorVersion?: () => number;
    projectItems?: EditableProjectItem[];
    dirty?: boolean;
    revision?: number;
    saveProject?: () => Effect.Effect<EffectApiTypes.Project | undefined, Error>;
    onCancellation?: (path: string, signal?: AbortSignal) => Promise<Response>;
    onRequest?: (method: string, path: string) => void | Promise<void>;
    capabilitiesResponse?: Response;
    onCapabilitiesRequest?: (
      path: string,
      signal: AbortSignal | undefined,
    ) => Response | Promise<Response>;
    preflightFailure?: EffectApiTypes.Error["error"];
    onPreflightRequest?: (request: {
      path: string;
      input: EffectApiTypes.ExportInput;
      signal: AbortSignal | undefined;
    }) => Promise<Response>;
    batchListResponse?: Promise<Response>;
    nextBatchListResponse?: () => Response;
    destinationsResponse?: Promise<Response>;
    nextDestinationsResponse?: () => Promise<Response>;
    exportResponses?: Response[];
    retryResponses?: Response[];
    onExportHeaders?: (headers: Headers, body: string | undefined, target: string) => void;
    onExportRequest?: (signal?: AbortSignal) => Promise<Response>;
    onRetryRequest?: (request: { path: string; key: string; body: string | undefined }) => void;
    onRetryResponse?: (path: string) => Promise<Response>;
    onApiRequest?: (path: string) => void;
    onBatchEvent?: (path: string, signal?: AbortSignal) => Promise<Response>;
  } = {},
) {
  let destinationRequestCount = 0;
  let batchRequestCount = 0;
  const initialBatch =
    options.initialBatch ??
    batch("running", 0.4, [
      job("j_exportstatus0001", "succeeded", 1),
      job("j_exportstatus0002", "running", 1),
    ]);
  const fetchOverride: typeof globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : input instanceof Request && input.body
            ? await input.clone().text()
            : undefined;
    await options.onRequest?.(method, requestUrl.pathname);
    if (method === "DELETE" && /^\/api\/v2\/(batches|jobs)\/[^/]+$/.test(requestUrl.pathname))
      return options.onCancellation
        ? options.onCancellation(
            requestUrl.pathname,
            init?.signal ?? (input instanceof Request ? input.signal : undefined),
          )
        : new Response(null, { status: 204 });
    if (requestUrl.pathname === "/api/v2/batches" && method === "GET") {
      if (options.nextBatchListResponse && batchRequestCount++ > 0)
        return options.nextBatchListResponse();
      return (
        options.batchListResponse?.then((response) => response.clone()) ??
        Promise.resolve(Response.json({ items: [initialBatch], nextCursor: null }))
      );
    }
    if (requestUrl.pathname.startsWith("/api/v2/export-capabilities/media/") && method === "GET")
      return options.onCapabilitiesRequest
        ? options.onCapabilitiesRequest(
            requestUrl.pathname,
            init?.signal ?? (input instanceof Request ? input.signal : undefined),
          )
        : (options.capabilitiesResponse?.clone() ?? Response.json({ strategies: [] }));
    if (requestUrl.pathname === "/api/v2/destinations") {
      if (options.nextDestinationsResponse && destinationRequestCount++ > 0)
        return options.nextDestinationsResponse();
      return (
        options.destinationsResponse ??
        Promise.resolve(
          Response.json({ destinations: [], capabilities: { saveBesideSource: false } }),
        )
      );
    }
    if (requestUrl.pathname.endsWith("/exports/preflight") && method === "POST")
      return options.onPreflightRequest
        ? options.onPreflightRequest({
            path: requestUrl.pathname,
            input: JSON.parse(body ?? "{}") as EffectApiTypes.ExportInput,
            signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
          })
        : options.preflightFailure
          ? Response.json({ error: options.preflightFailure }, { status: 400 })
          : Response.json({ allowed: true, selection: [], findings: [] });
    if (/^\/api\/v2\/jobs\/[^/]+\/retry$/.test(requestUrl.pathname) && method === "POST") {
      options.onRetryRequest?.({
        path: requestUrl.pathname,
        key: headers.get("Idempotency-Key") ?? "",
        body,
      });
      if (options.onRetryResponse) return options.onRetryResponse(requestUrl.pathname);
      const response = options.retryResponses?.shift();
      if (response) return response;
      return Response.json(batch("queued", 0.1, [job("j_exportretry0001", "queued", 1)]), {
        status: 202,
      });
    }
    if (requestUrl.pathname.endsWith("/exports") && method === "POST") {
      options.onExportHeaders?.(headers, body, requestUrl.pathname.split("/").at(-2) ?? "");
      if (options.onExportRequest) return options.onExportRequest(init?.signal ?? undefined);
      const response = options.exportResponses?.shift();
      if (response) return response;
      return Response.json(
        {
          batchId,
          jobs: [job("j_exportfresh0001", "queued", 1)],
        },
        { status: 202 },
      );
    }
    throw new Error(`Unexpected generated API request: ${method} ${requestUrl}`);
  };
  const api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest"> = {
    url: (path) => path,
    request: async (path, init) => {
      options.onApiRequest?.(path);
      if (path.endsWith("/events") && options.onBatchEvent)
        return options.onBatchEvent(path, init?.signal ?? undefined);
      if (path === `batches/${batchId}/events`) {
        const data = [
          "id: export-status-1",
          "event: snapshot",
          `data: ${JSON.stringify(terminalBatch)}`,
          "",
          "",
        ].join("\n");
        return new Response(data, { headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error(`Unexpected API request: ${path} (${init?.method ?? "GET"})`);
    },
    assetRequest: () => Promise.reject(new Error("Unexpected asset request")),
    mediaRequest: () => Promise.reject(new Error("Unexpected media attachment request")),
  };
  let controller!: ExportController;
  let controls!: Parameters<typeof exercise>[1];
  const preferences: Partial<typeof defaultBrowserPreferences>[] = [];
  let dirtyCount = 0;
  const root = createControllerTestRoot(
    ({ registry, configuration }) => {
      untrack(() => {
        const documentContext = Atom.keepAlive(
          Atom.make<PreflightContext>({
            projectId: options.projectId?.() ?? "p_exportstatus0001",
            revision: options.revision ?? 1,
            dirty: options.dirty ?? false,
            editVersion: options.editorVersion?.() ?? 0,
            generation: 0,
          }),
        );
        const observedContext = useAtomValue(() => documentContext);
        const dirty = () => observedContext().dirty;
        const itemsAtom = Atom.keepAlive(
          Atom.make<EditableProjectItem[]>(options.projectItems ?? []),
        );
        const projectItems = useAtomValue(() => itemsAtom);
        const context = Atom.keepAlive(
          Atom.make({
            activeItemId: options.projectItems?.[0]?.id,
            selectedMediaId: options.selected?.id,
            status: "",
          }),
        );
        const server = createServerState(api, registry, configuration);
        controls = {
          items: () => registry.get(itemsAtom),
          replaceItems: (items) => registry.set(itemsAtom, items),
          activate: (id) =>
            registry.set(context, {
              activeItemId: id,
              selectedMediaId: registry.get(itemsAtom).find((item) => item.id === id)?.media.id,
              status: "",
            }),
          preferences,
          dirtyCount: () => dirtyCount,
          refreshOptions: () => registry.refresh(controller.optionsAtom),
          updateContext: (context) =>
            registry.update(documentContext, (value) => ({ ...value, ...context })),
          setNotice: (status) => registry.update(context, (value) => ({ ...value, status })),
          registry,
          server,
          refreshMedia: server.refreshMedia,
          dispose: () => root.dispose(),
        };
        controller = createExportController({
          server,
          itemsAtom,
          optionsContext: context,
          preflightContext: documentContext,
          selected: () => options.selected,
          projectId: options.projectId ?? (() => observedContext().projectId),
          revision: () => observedContext().revision,
          dirty,
          editorVersion: options.editorVersion ?? (() => observedContext().editVersion),
          status: () => "",
          editableItems: projectItems,
          saveProject: options.saveProject ?? (() => Effect.succeed(undefined)),
          markDirty: () => {
            dirtyCount++;
            registry.update(documentContext, (context) => ({
              ...context,
              dirty: true,
              editVersion: context.editVersion + 1,
            }));
          },
          saveSettings: (changes) => {
            preferences.push(changes);
          },
        });
      });
      return undefined;
    },
    { fetch: fetchOverride, storage: memoryStorage() },
  );
  try {
    exportRegistries.set(controller, controls.registry);
    await exercise(controller, controls);
  } finally {
    root.dispose();
  }
}

async function waitForStatus(controller: ExportController, expected: string) {
  const deadline = Date.now() + 2_000;
  while (controller.exportStatus() !== expected) {
    if (Date.now() >= deadline)
      throw new Error(
        `Expected export status ${JSON.stringify(expected)}, got ${JSON.stringify(controller.exportStatus())}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("export strategy capabilities", () => {
  it("switches capability identity with the selected media", async () => {
    const secondMedia = { ...media, id: `m_${"n".repeat(43)}` };
    const secondItem = { ...exportItem(secondMedia), id: `i_${"n".repeat(24)}` };
    const requests: string[] = [];
    await withExportController(
      batch("succeeded", 1, []),
      async (controller, controls) => {
        const releaseFirst = controls.registry.mount(
          controls.server.exportCapabilities(media.id, 0),
        );
        controller.hybridSmartCutSupported();
        await vi.waitFor(() => expect(controller.hybridSmartCutSupported()).toBe(true));
        releaseFirst();
        controls.activate(secondItem.id);
        const releaseSecond = controls.registry.mount(
          controls.server.exportCapabilities(secondMedia.id, 0),
        );
        expect(controller.hybridSmartCutSupported()).toBeUndefined();
        await vi.waitFor(() => expect(controller.hybridSmartCutSupported()).toBe(false));
        releaseSecond();
        expect(new Set(requests)).toEqual(
          new Set([
            `/api/v2/export-capabilities/media/${media.id}`,
            `/api/v2/export-capabilities/media/${secondMedia.id}`,
          ]),
        );
      },
      {
        selected: media,
        projectItems: [exportItem(media), secondItem],
        onCapabilitiesRequest: (path) => {
          requests.push(path);
          return Response.json({
            strategies: [
              {
                strategy: "hybrid_smart_cut",
                supported: path.endsWith(secondMedia.id) ? false : true,
                reasons: path.endsWith(secondMedia.id) ? ["unsupported_video_codec"] : [],
              },
            ],
          });
        },
      },
    );
  });

  it("invalidates capability when the same media is refreshed", async () => {
    let resolveRefresh!: (response: Response) => void;
    let requests = 0;
    let refreshing = false;
    await withExportController(
      batch("succeeded", 1, []),
      async (controller, controls) => {
        const releaseInitial = controls.registry.mount(
          controls.server.exportCapabilities(media.id, 0),
        );
        controller.hybridSmartCutSupported();
        await vi.waitFor(() => expect(controller.hybridSmartCutSupported()).toBe(false));
        refreshing = true;
        controls.refreshMedia();
        releaseInitial();
        const releaseRefresh = controls.registry.mount(
          controls.server.exportCapabilities(media.id, 1),
        );
        await vi.waitFor(() => expect(requests).toBe(1));
        expect(controller.hybridSmartCutSupported()).toBeUndefined();
        resolveRefresh(
          Response.json({
            strategies: [{ strategy: "hybrid_smart_cut", supported: true, reasons: [] }],
          }),
        );
        await vi.waitFor(() => expect(controller.hybridSmartCutSupported()).toBe(true));
        releaseRefresh();
      },
      {
        selected: media,
        onCapabilitiesRequest: () => {
          if (!refreshing)
            return Response.json({
              strategies: [
                {
                  strategy: "hybrid_smart_cut",
                  supported: false,
                  reasons: ["unsupported_video_codec"],
                },
              ],
            });
          requests++;
          return new Promise((resolve) => {
            resolveRefresh = resolve;
          });
        },
      },
    );
  });

  it("cancels a pending request on selection change and ignores its late response", async () => {
    const secondMedia = { ...media, id: `m_${"n".repeat(43)}` };
    const secondItem = { ...exportItem(secondMedia), id: `i_${"n".repeat(24)}` };
    let resolveOld!: (response: Response) => void;
    let oldSignal: AbortSignal | undefined;
    await withExportController(
      batch("succeeded", 1, []),
      async (controller, controls) => {
        controller.hybridSmartCutSupported();
        await vi.waitFor(() => expect(oldSignal).toBeDefined());
        controls.activate(secondItem.id);
        await vi.waitFor(() => expect(controller.hybridSmartCutSupported()).toBe(true));
        await vi.waitFor(() => expect(oldSignal?.aborted).toBe(true));
        resolveOld(
          Response.json({
            strategies: [
              {
                strategy: "hybrid_smart_cut",
                supported: false,
                reasons: ["unsupported_video_codec"],
              },
            ],
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(controller.hybridSmartCutSupported()).toBe(true);
      },
      {
        selected: media,
        projectItems: [exportItem(media), secondItem],
        onCapabilitiesRequest: (path, signal) => {
          if (path.endsWith(media.id)) {
            oldSignal = signal;
            return new Promise((resolve) => {
              resolveOld = resolve;
            });
          }
          return Response.json({
            strategies: [{ strategy: "hybrid_smart_cut", supported: true, reasons: [] }],
          });
        },
      },
    );
  });

  it("cancels a pending capability request when its workspace is disposed", async () => {
    let signal: AbortSignal | undefined;
    await withExportController(
      batch("succeeded", 1, []),
      async (controller, controls) => {
        controller.hybridSmartCutSupported();
        await vi.waitFor(() => expect(signal).toBeDefined());
        controls.dispose();
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      },
      {
        selected: media,
        onCapabilitiesRequest: (_path, requestSignal) => {
          signal = requestSignal;
          return new Promise(() => {});
        },
      },
    );
  });

  it("keeps backend-owned false and exposes settled transport and decode failures as unknown", async () => {
    await withExportController(
      batch("succeeded", 1, []),
      async (controller) => {
        controller.hybridSmartCutSupported();
        await vi.waitFor(() => expect(controller.hybridSmartCutSupported()).toBe(false));
      },
      {
        selected: media,
        capabilitiesResponse: Response.json({
          strategies: [
            {
              strategy: "hybrid_smart_cut",
              supported: false,
              reasons: ["unsupported_video_codec"],
            },
          ],
        }),
      },
    );

    for (const response of [
      Response.json({ error: "unavailable" }, { status: 500 }),
      Response.json({
        strategies: [{ strategy: "hybrid_smart_cut", supported: "not-a-boolean", reasons: [] }],
      }),
    ]) {
      await withExportController(
        batch("succeeded", 1, []),
        async (controller, controls) => {
          const atom = controls.server.exportCapabilities(media.id, 0);
          const release = controls.registry.mount(atom);
          controller.hybridSmartCutSupported();
          await vi.waitFor(() =>
            expect(AsyncResult.isFailure(controls.registry.get(atom))).toBe(true),
          );
          expect(controller.hybridSmartCutSupported()).toBeUndefined();
          release();
        },
        { selected: media, capabilitiesResponse: response },
      );
    }
  });
});

describe("export controller aggregate status", () => {
  it("retains the current batch outside the first page and invalidates each terminal job once", async () => {
    let lists = 0;
    let mediaRefreshes = 0;
    const completed = batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 2)]);
    await withExportController(
      completed,
      async (controller) => {
        await waitForStatus(controller, "Export complete.");
        await vi.waitFor(() => expect(lists).toBe(2));
        expect(controller.batchId()).toBe(batchId);
        expect(controller.batches().map((batch) => batch.batchId)).toContain(batchId);
        expect(controller.batchJobs()[0].state).toBe("succeeded");
        const refreshes = mediaRefreshes;
        controller.refreshBatches();
        await vi.waitFor(() => expect(lists).toBe(3));
        expect(mediaRefreshes).toBe(refreshes);
        expect(controller.batchId()).toBe(batchId);
      },
      {
        nextBatchListResponse: () => Response.json({ items: [], nextCursor: null }),
        onRequest: (method, path) => {
          if (method === "GET" && path === "/api/v2/batches") lists++;
          if (method === "GET" && path === "/api/v2/media") mediaRefreshes++;
        },
      },
    );
  });

  it("rejects malformed generated batch pages without starting observations", async () => {
    let observations = 0;
    await withExportController(
      batch("succeeded", 1, []),
      async (controller) => {
        await vi.waitFor(() => expect(controller.batchesError()).not.toBe(""));
        expect(controller.batches()).toEqual([]);
        expect(controller.batchId()).toBeUndefined();
        expect(observations).toBe(0);
      },
      {
        batchListResponse: Promise.resolve(Response.json({ items: [null], nextCursor: null })),
        onBatchEvent: async () => {
          observations++;
          return new Response(null);
        },
      },
    );
  });

  it("disposes queue subscriptions without cancelling durable jobs or processing later pages", async () => {
    let resolveList!: (response: Response) => void;
    const pendingList = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
    let cancellations = 0;
    await withExportController(
      batch("succeeded", 1, []),
      async (controller, controls) => {
        await vi.waitFor(() => expect(controller.batchesLoading()).toBe(true));
        controls.dispose();
        resolveList(Response.json({ items: [batch("running", 0.5, [])], nextCursor: null }));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(cancellations).toBe(0);
      },
      {
        batchListResponse: pendingList,
        onRequest: (method) => {
          if (method === "DELETE") cancellations++;
        },
      },
    );
  });

  it("owns options in item documents, retains item edits, and propagates only explicit containers", async () => {
    const first = exportItem({
      id: "m_first",
      name: "first.mkv",
      durationMs: 2000,
      sizeBytes: 1,
      container: "mkv",
      streams: {},
      etag: "v1",
    });
    const second = {
      ...exportItem({ ...first.media, id: "m_second" }),
      id: "i_second",
      exportOptions: {
        mode: "separate" as const,
        destinationId: "archive",
        container: "mov" as const,
      },
    };
    await withExportController(
      batch("succeeded", 1, []),
      async (controller, controls) => {
        expect(controller.exportItemIDs()).toEqual([first.id]);
        controller.setMode("separate");
        controller.setSelection("gaps");
        controller.setStreams([2]);
        controller.setStrategy("precise_reencode");
        controller.setTemplate("{source}.{ext}");
        expect(controller.setTemplate("é".repeat(81))).toBe(false);
        expect(controls.preferences).toEqual([
          { cutStrategy: "precise_reencode" },
          { filenameTemplate: "{source}.{ext}" },
        ]);
        expect(controls.items()[0].exportOptions).toMatchObject({
          mode: "separate",
          selection: "gaps",
          streamIndexes: [2],
          filenameTemplate: "{source}.{ext}",
        });
        controller.chooseExportScope("selected");
        controller.chooseExportItems([first.id]);
        controller.setContainer("mp4");
        controller.chooseExportItems([first.id, second.id]);
        expect(controls.items()[1].exportOptions).toEqual({
          mode: "separate",
          destinationId: "archive",
          container: "mp4",
        });
        controls.activate(second.id);
        expect(controller.destinationId()).toBe("archive");
        controller.setMode("merge");
        controls.activate(first.id);
        expect(controller.exportSelection()).toBe("gaps");
        expect(controller.streamIndexes()).toEqual([2]);
        expect(controller.exportMode()).toBe("separate");
        controls.refreshOptions();
        expect(controller.exportSelection()).toBe("gaps");
        expect(controller.selectionAtom.keepAlive).toBe(true);
        expect(controls.dirtyCount()).toBeGreaterThan(0);
        controls.replaceItems([first]);
        expect(controller.selectedExportItems()).toEqual([first.id]);
        controls.replaceItems([first, second]);
        expect(controller.selectedExportItems()).toEqual([first.id]);
      },
      { selected: first.media, projectItems: [first, second], dirty: true },
    );
  });
  it("falls back unavailable destinations and refuses unsupported source-adjacent commands", async () => {
    const first = exportItem({
      id: "m_destination",
      name: "clip.mkv",
      durationMs: 2000,
      sizeBytes: 1,
      container: "mkv",
      streams: {},
      etag: "v1",
    });
    first.exportOptions.destinationId = "missing";
    await withExportController(
      batch("succeeded", 1, []),
      async (controller, controls) => {
        await expect.poll(() => controller.destinationsLoading()).toBe(false);
        await expect.poll(() => controller.destinationId()).toBe("download");
        expect(controller.destinationStatus()).toBe(
          "Remembered destination is unavailable. Using Downloads.",
        );
        controller.setDestination("source");
        controller.setItemDestination(first.id, "source");
        expect(controller.destinationId()).toBe("download");
        expect(controller.availableDestinations().map((destination) => destination.id)).toEqual([
          "download",
          "archive",
        ]);
        controller.setDestination("archive");
        expect(controls.items()[0].exportOptions.destinationId).toBe("archive");
        expect(controls.preferences).toEqual([{ lastDestinationId: "archive" }]);
        expect(controller.destinationStatus()).toBe("");
      },
      {
        selected: first.media,
        projectItems: [first],
        dirty: true,
        destinationsResponse: Promise.resolve(
          Response.json({
            destinations: [
              { id: "source", label: "Beside source", kind: "source_adjacent" },
              { id: "download", label: "Downloads", kind: "download" },
              { id: "archive", label: "Archive", kind: "archive" },
            ],
            capabilities: { saveBesideSource: false },
          }),
        ),
      },
    );
  });
  it("keeps read errors empty while generated reads are waiting and after success", async () => {
    let resolveBatches!: (response: Response) => void;
    let resolveDestinations!: (response: Response) => void;
    const batchListResponse = new Promise<Response>((resolve) => (resolveBatches = resolve));
    const destinationsResponse = new Promise<Response>(
      (resolve) => (resolveDestinations = resolve),
    );
    await withExportController(
      batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 2)]),
      async (controller) => {
        const deadline = Date.now() + 2_000;
        while (!controller.destinationsLoading() || !controller.batchesLoading()) {
          if (Date.now() >= deadline) throw new Error("Generated export reads did not start.");
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(controller.destinationsError()).toBe("");
        expect(controller.batchesError()).toBe("");
        resolveBatches(
          Response.json({
            items: [batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 2)])],
            nextCursor: null,
          }),
        );
        resolveDestinations(
          Response.json({
            destinations: [{ id: "download", label: "Downloads", kind: "download" }],
            capabilities: { saveBesideSource: false },
          }),
        );
        const settledDeadline = Date.now() + 2_000;
        while (!controller.destinations().length || !controller.batches().length) {
          if (Date.now() >= settledDeadline)
            throw new Error("Generated export reads did not settle.");
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(controller.destinationsLoading()).toBe(false);
        expect(controller.batchesLoading()).toBe(false);
        expect(controller.destinationsError()).toBe("");
        expect(controller.batchesError()).toBe("");
        expect(controller.destinations()).toEqual([
          { id: "download", label: "Downloads", kind: "download" },
        ]);
        expect(controller.destinationCapabilities()).toEqual({ saveBesideSource: false });
      },
      { batchListResponse, destinationsResponse },
    );
  });
  it("keeps generated destination data current through refresh, selection fallback, and failure", async () => {
    const sourceAdjacent = {
      id: "source",
      label: "Beside source",
      kind: "source_adjacent" as const,
    };
    const downloads = { id: "download", label: "Downloads", kind: "download" as const };
    let refreshDestinations!: (response: Response) => void;
    let failDestinations!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => (refreshDestinations = resolve));
    const failureResponse = new Promise<Response>((resolve) => (failDestinations = resolve));
    let requests = 0;
    await withExportController(
      batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 2)]),
      async (controller) => {
        const deadline = Date.now() + 2_000;
        while (!controller.destinations().length || controller.destinationsLoading()) {
          if (Date.now() >= deadline) throw new Error("Initial destination read did not settle.");
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(controller.destinations()).toEqual([sourceAdjacent, downloads]);
        expect(controller.destinationCapabilities()).toEqual({ saveBesideSource: true });

        controller.setDestination("source");
        controller.retryDestinations();
        while (!controller.destinationsLoading()) {
          if (Date.now() >= deadline) throw new Error("Destination refresh did not start.");
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(controller.destinations()).toEqual([sourceAdjacent, downloads]);
        expect(controller.destinationsError()).toBe("");
        refreshDestinations(
          Response.json({ destinations: [downloads], capabilities: { saveBesideSource: false } }),
        );
        while (controller.destinationsLoading() || controller.destinationId() !== "download") {
          if (Date.now() >= deadline) throw new Error("Destination refresh did not settle.");
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(controller.destinations()).toEqual([downloads]);
        expect(controller.destinationCapabilities()).toEqual({ saveBesideSource: false });

        controller.retryDestinations();
        while (!controller.destinationsLoading()) {
          if (Date.now() >= deadline) throw new Error("Destination retry did not start.");
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(controller.destinations()).toEqual([downloads]);
        failDestinations(
          Response.json(
            {
              error: {
                code: "internal_error",
                message: "Destination refresh failed.",
                requestId: "r-destination-refresh",
              },
            },
            { status: 500 },
          ),
        );
        while (controller.destinationsLoading()) {
          if (Date.now() >= deadline) throw new Error("Destination failure did not settle.");
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(controller.destinations()).toEqual([downloads]);
        expect(controller.destinationCapabilities()).toEqual({ saveBesideSource: false });
        expect(controller.destinationsError()).toBe("Destination refresh failed.");
        expect(requests).toBe(2);
      },
      {
        destinationsResponse: Promise.resolve(
          Response.json({
            destinations: [sourceAdjacent, downloads],
            capabilities: { saveBesideSource: true },
          }),
        ),
        nextDestinationsResponse: () => {
          requests++;
          return requests === 1 ? refreshResponse : failureResponse;
        },
      },
    );
  });
  it("projects generated read errors only after the resource actually fails", async () => {
    await withExportController(
      batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 2)]),
      async (controller) => {
        const deadline = Date.now() + 2_000;
        while (
          controller.destinationsError() !== "Destination lookup is unavailable." ||
          controller.batchesError() !== "Batch listing is unavailable."
        ) {
          if (Date.now() >= deadline)
            throw new Error(
              `Generated read failures did not settle: destinations=${controller.destinationsError()}, batches=${controller.batchesError()}`,
            );
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(controller.destinationsLoading()).toBe(false);
        expect(controller.batchesLoading()).toBe(false);
        expect(controller.destinationsError()).toBe("Destination lookup is unavailable.");
        expect(controller.batchesError()).toBe("Batch listing is unavailable.");
      },
      {
        batchListResponse: Promise.resolve(
          Response.json(
            {
              error: {
                code: "internal_error",
                message: "Batch listing is unavailable.",
                requestId: "r-batches",
              },
            },
            { status: 500 },
          ),
        ),
        destinationsResponse: Promise.resolve(
          Response.json(
            {
              error: {
                code: "internal_error",
                message: "Destination lookup is unavailable.",
                requestId: "r-destinations",
              },
            },
            { status: 500 },
          ),
        ),
      },
    );
  });
  it("saves before a fresh generated preflight and generated keyed submission", async () => {
    const item = exportItem(media);
    const calls: string[] = [];
    await withExportController(
      batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 2)]),
      async (controller) => {
        const deadline = Date.now() + 2_000;
        while (controller.preflightPending() || calls.length === 0) {
          if (Date.now() >= deadline) throw new Error("Initial preflight did not finish.");
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        controller.setMode("separate");
        await submitExport(controller);
        expect(calls).toEqual(["preflight", "save", "preflight", "submit"]);
      },
      {
        initialBatch: batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 1)]),
        selected: media,
        projectItems: [item],
        dirty: false,
        revision: 2,
        onRequest: (_method, path) => {
          if (_method !== "POST") return;
          calls.push(path.endsWith("/preflight") ? "preflight" : "submit");
        },
        saveProject: () =>
          Effect.sync(() => {
            calls.push("save");
            return {
              id: "p_exportstatus0001",
              name: "Saved",
              revision: 2,
              updatedAt: timestamp,
              schemaVersion: 2,
              items: [],
            };
          }),
      },
    );
  });
  it("coalesces clicks, accepts its own saved revision, and clears native phase", async () => {
    let complete!: (project: EffectApiTypes.Project) => void;
    let saves = 0;
    let submittedRevision: number | undefined;
    const response = new Promise<EffectApiTypes.Project>((resolve) => {
      complete = resolve;
    });
    await withExportController(
      batch("succeeded", 1, []),
      async (controller, controls) => {
        const exporting = submitExport(controller);
        controller.exportProject();
        expect(saves).toBe(1);
        expect(controller.exportPending()).toBe(true);
        expect(controller.exportPhase()).toBe("saving");
        controls.updateContext({ revision: 2, dirty: false });
        complete({
          id: "p_exportstatus0001",
          name: "Saved",
          revision: 2,
          updatedAt: timestamp,
          schemaVersion: 2,
          items: [],
        });
        await exporting;
        expect(submittedRevision).toBe(2);
        expect(controller.exportPending()).toBe(false);
        expect(controller.exportPhase()).toBeUndefined();
      },
      {
        selected: preflightMedia,
        projectItems: [exportItem(preflightMedia)],
        dirty: true,
        initialBatch: batch("succeeded", 1, []),
        saveProject: () =>
          Effect.promise(() => {
            saves++;
            return response;
          }),
        onExportHeaders: (_headers, body) => {
          submittedRevision = (JSON.parse(body!) as EffectApiTypes.ExportSubmissionInput)
            .projectRevision;
        },
      },
    );
  });

  it("retains an interrupted uncertain submission key without claiming cancellation", async () => {
    const keys: string[] = [];
    let resolveFirst!: (response: Response) => void;
    let started!: () => void;
    const submitting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    await withExportController(
      batch("succeeded", 1, []),
      async (controller) => {
        const first = submitExport(controller);
        await submitting;
        expect(controller.exportPhase()).toBe("submitting");
        controller.clearExportContext();
        await first;
        expect(controller.exportPending()).toBe(false);
        expect(controller.exportStatus()).not.toContain("cancelled");
        resolveFirst(
          Response.json(
            { batchId, jobs: [job("j_exportfresh0001", "queued", 1)] },
            { status: 202 },
          ),
        );
        await submitExport(controller);
        expect(keys).toHaveLength(2);
        expect(keys[1]).toBe(keys[0]);
      },
      {
        selected: preflightMedia,
        projectItems: [exportItem(preflightMedia)],
        initialBatch: batch("succeeded", 1, []),
        onExportHeaders: (headers) => keys.push(headers.get("Idempotency-Key")!),
        onExportRequest: () => {
          if (calls++ === 0) {
            started();
            return new Promise((resolve) => {
              resolveFirst = resolve;
            });
          }
          return Promise.resolve(
            Response.json(
              { batchId, jobs: [job("j_exportfresh0001", "queued", 1)] },
              { status: 202 },
            ),
          );
        },
      },
    );
  });

  it("does not publish a submission or its failure into a changed edit context", async () => {
    for (const response of [
      Response.json({ batchId, jobs: [job("j_exportfresh0001", "queued", 1)] }, { status: 202 }),
      Response.json(
        { error: { code: "export_busy", message: "Busy", requestId: "r-busy" } },
        { status: 429 },
      ),
    ]) {
      let complete!: (response: Response) => void;
      let started!: () => void;
      const submitting = new Promise<void>((resolve) => {
        started = resolve;
      });
      await withExportController(
        batch("succeeded", 1, []),
        async (controller, controls) => {
          const exporting = submitExport(controller);
          await submitting;
          controls.updateContext({ editVersion: 1 });
          complete(response);
          await exporting;
          expect(controller.exportJob()).toBeUndefined();
          expect(controller.exportPending()).toBe(false);
          expect(controller.exportStatus()).toContain("project changed");
        },
        {
          selected: preflightMedia,
          projectItems: [exportItem(preflightMedia)],
          initialBatch: batch("succeeded", 1, []),
          onExportRequest: () => {
            started();
            return new Promise((resolve) => {
              complete = resolve;
            });
          },
        },
      );
    }
  });

  it("keeps save failures in the native result and never preflights or submits", async () => {
    let requests = 0;
    await withExportController(
      batch("succeeded", 1, []),
      async (controller, controls) => {
        await submitExport(controller);
        expect(AsyncResult.isFailure(controls.registry.get(controller.exportCommand))).toBe(true);
        expect(controller.exportStatus()).toBe("Save denied");
        expect(controller.exportPending()).toBe(false);
        expect(requests).toBe(0);
      },
      {
        selected: preflightMedia,
        projectItems: [exportItem(preflightMedia)],
        dirty: true,
        initialBatch: batch("succeeded", 1, []),
        saveProject: () => Effect.fail(new Error("Save denied")),
        onRequest: (method) => {
          if (method === "POST") requests++;
        },
      },
    );
  });

  it("stops after a save when the editor version changed during the save", async () => {
    let editorVersion = 0;
    let signalSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      signalSaveStarted = resolve;
    });
    let finishSave!: (project: EffectApiTypes.Project) => void;
    const saveResponse = new Promise<EffectApiTypes.Project>((resolve) => {
      finishSave = resolve;
    });
    const calls: string[] = [];
    let saves = 0;
    await withExportController(
      batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 1)]),
      async (controller) => {
        const exporting = submitExport(controller);
        await saveStarted;
        editorVersion++;
        finishSave({
          id: "p_exportstatus0001",
          name: "Saved",
          revision: 2,
          updatedAt: timestamp,
          schemaVersion: 2,
          items: [],
        });
        await exporting;
        expect(saves).toBe(1);
        expect(calls).toEqual([]);
        expect(controller.exportStatus()).toBe(
          "Create clips stopped because the project changed. Save again and retry.",
        );
      },
      {
        selected: media,
        projectItems: [exportItem(media)],
        dirty: true,
        revision: 2,
        editorVersion: () => editorVersion,
        saveProject: () =>
          Effect.promise(() => {
            saves++;
            signalSaveStarted();
            return saveResponse;
          }),
        onRequest: (method, path) => {
          if (method === "POST") calls.push(path.endsWith("/preflight") ? "preflight" : "submit");
        },
      },
    );
  });
  it.each([
    { context: "another project", code: "internal_error", switchProject: true },
    { context: "the same project", code: "upstream_timeout", switchProject: false },
  ])("scopes an uncertain export retry identity to $context", async ({ code, switchProject }) => {
    let projectId = "p_exportstatus0001";
    const attempts: Array<{ target: string; key: string; body: string | undefined }> = [];
    const events: string[] = [];
    await withExportController(
      batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 2)]),
      async (controller) => {
        expect(events).toHaveLength(0);
        await submitExport(controller);
        if (switchProject) projectId = "p_exportstatus0002";
        await submitExport(controller);
        expect(attempts).toHaveLength(2);
        expect(attempts.map(({ target }) => target)).toEqual(["p_exportstatus0001", projectId]);
        expect(attempts[1].body).toBe(attempts[0].body);
        expect(JSON.parse(attempts[0].body ?? "{}")).toEqual({ projectRevision: 1 });
        expect(attempts[0].key).toBeTruthy();
        expect(attempts[1].key).toBeTruthy();
        if (switchProject) expect(attempts[1].key).not.toBe(attempts[0].key);
        else expect(attempts[1]).toEqual(attempts[0]);
      },
      {
        initialBatch: batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 1)]),
        selected: media,
        projectId: () => projectId,
        projectItems: [exportItem(media)],
        dirty: false,
        exportResponses: [
          Response.json(
            { error: { code, message: "Try again.", requestId: "r-export-timeout" } },
            { status: 500 },
          ),
          Response.json(
            { batchId, jobs: [job("j_exportfresh0001", "queued", 1)] },
            { status: 202 },
          ),
        ],
        onExportHeaders: (headers, body, target) =>
          attempts.push({ target, key: headers.get("Idempotency-Key") ?? "", body }),
        onApiRequest: (path) => {
          if (path.endsWith("/events")) events.push(path);
        },
      },
    );
  });

  it("suppresses duplicate retry and cancellation overlap while unrelated children proceed", async () => {
    const failed = batch("failed", 1, [job("j_retryfirst001", "failed", 1)]);
    const responses = new Map<string, (response: Response) => void>();
    const cancellations: string[] = [];
    await withExportController(
      failed,
      async (controller, { registry }) => {
        await vi.waitFor(() => expect(controller.batches()).toHaveLength(1));
        controller.retryChildJob("j_retryfirst001", batchId);
        controller.retryChildJob("j_retryfirst001", batchId);
        controller.cancelChildJob("j_retryfirst001");
        controller.retryChildJob("j_retrysecond01", batchId);
        controller.cancelChildJob("j_retrythird001");
        controller.retryChildJob("j_retrythird001", batchId);
        await vi.waitFor(() => expect(responses.size).toBe(2));
        expect(cancellations).toEqual(["/api/v2/jobs/j_retrythird001"]);
        expect(controller.childJobPending("j_retryfirst001")).toBe(true);
        for (const [path, respond] of responses) {
          respond(
            Response.json(
              {
                error: {
                  code: "job_not_retryable",
                  message: "Not retryable.",
                  requestId: "request",
                },
              },
              { status: 409 },
            ),
          );
          const id = path.split("/").at(-2)!;
          await Effect.runPromise(
            AtomRegistry.getResult(registry, controller.retryCommands(id), {
              suspendOnWaiting: true,
            }).pipe(Effect.exit),
          );
        }
        expect(controller.childJobPending("j_retryfirst001")).toBe(false);
        expect(controller.childJobPending("j_retrysecond01")).toBe(false);
      },
      {
        initialBatch: failed,
        onBatchEvent: () => new Promise(() => {}),
        onRetryResponse: (path) => new Promise((resolve) => responses.set(path, resolve)),
        onCancellation: (path) => {
          cancellations.push(path);
          return new Promise(() => {});
        },
      },
    );
  });

  it("selects a validated retry batch only for the still-matching active export", async () => {
    const active = batch("running", 0.5, [job("j_retryactive01", "running", 1)]);
    const retried = {
      ...batch("queued", 0, [job("j_retryactive02", "queued", 1)]),
      batchId: "b_retryactive02",
    };
    await withExportController(
      active,
      async (controller) => {
        await vi.waitFor(() => expect(controller.batchId()).toBe(batchId));
        await retryChild(controller, "j_retryactive01", batchId);
        expect(controller.batchId()).toBe(retried.batchId);
        expect(controller.exportStatus()).toBe("Export retry queued as a new job.");
        expect(controller.batchJobs()[0].id).toBe("j_retryactive02");
      },
      {
        initialBatch: active,
        retryResponses: [Response.json(retried, { status: 202 })],
        onBatchEvent: () => new Promise(() => {}),
      },
    );
  });

  it("resets retry identity after explicit rejection and success", async () => {
    const failed = batch("failed", 1, [job("j_retryidentity1", "failed", 1)]);
    const keys: string[] = [];
    await withExportController(
      failed,
      async (controller) => {
        await retryChild(controller, "j_retryidentity1", batchId);
        await retryChild(controller, "j_retryidentity1", batchId);
        await retryChild(controller, "j_retryidentity1", batchId);
        expect(new Set(keys).size).toBe(3);
      },
      {
        initialBatch: failed,
        onRetryRequest: ({ key }) => keys.push(key),
        retryResponses: [
          Response.json(
            {
              error: { code: "job_not_retryable", message: "Not retryable.", requestId: "request" },
            },
            { status: 409 },
          ),
          Response.json(batch("queued", 0, [job("j_retryidentity2", "queued", 1)]), {
            status: 202,
          }),
        ],
      },
    );
  });

  it("does not observe an invalid retry response and retains its uncertain identity", async () => {
    const failed = batch("failed", 1, [job("j_retryinvalid01", "failed", 1)]);
    const events: string[] = [];
    const keys: string[] = [];
    await withExportController(
      failed,
      async (controller) => {
        await vi.waitFor(() => expect(controller.batches()).toHaveLength(1));
        await retryChild(controller, "j_retryinvalid01", batchId);
        expect(controller.batchId()).toBeUndefined();
        expect(events).not.toContain("batches/b_invalidretry01/events");
        await retryChild(controller, "j_retryinvalid01", batchId);
        expect(keys[1]).toBe(keys[0]);
      },
      {
        initialBatch: failed,
        onApiRequest: (path) => events.push(path),
        onRetryRequest: ({ key }) => keys.push(key),
        retryResponses: [Response.json({ batchId: "b_invalidretry01", jobs: [] }, { status: 202 })],
      },
    );
  });

  it.each(["success", "rejection"])(
    "late retry %s cannot replace a newer context or notices",
    async (outcome) => {
      const failed = batch("failed", 1, [job("j_retrycontext01", "failed", 1)]);
      const retried = {
        ...batch("queued", 0, [job("j_retrycontext02", "queued", 1)]),
        batchId: "b_retrycontext02",
      };
      let respond!: (response: Response) => void;
      const events: string[] = [];
      await withExportController(
        failed,
        async (controller, { updateContext }) => {
          await vi.waitFor(() => expect(controller.batchId()).toBe(batchId));
          const completion = retryChild(controller, "j_retrycontext01", batchId);
          await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
          updateContext({ generation: 2 });
          controller.clearExportContext();
          respond(
            outcome === "success"
              ? Response.json(retried, { status: 202 })
              : Response.json(
                  {
                    error: {
                      code: "job_not_retryable",
                      message: "Old rejection",
                      requestId: "request",
                    },
                  },
                  { status: 409 },
                ),
          );
          await completion;
          expect(controller.batchId()).toBeUndefined();
          expect(controller.exportStatus()).toBe("");
          if (outcome === "success")
            await vi.waitFor(() => expect(events).toContain("batches/b_retrycontext02/events"));
          else expect(events).not.toContain("batches/b_retrycontext02/events");
        },
        {
          initialBatch: batch("running", 0.5, [job("j_retrycontext01", "running", 1)]),
          onRetryResponse: () =>
            new Promise((resolve) => {
              respond = resolve;
            }),
          onApiRequest: (path) => events.push(path),
          onBatchEvent: () => new Promise(() => {}),
        },
      );
    },
  );

  it("redelivers an unfamiliar generated retry failure with the same key and operation", async () => {
    const failedJob = job("j_exportstatus0001", "failed", 1);
    const attempts: Array<{ path: string; key: string; body: string | undefined }> = [];
    const events: string[] = [];
    await withExportController(
      batch("failed", 1, [failedJob]),
      async (controller) => {
        expect(events).toHaveLength(0);
        await retryChild(controller, failedJob.id, batchId);
        await retryChild(controller, failedJob.id, batchId);
        expect(attempts).toHaveLength(2);
        expect(attempts[0].key).toBeTruthy();
        expect(attempts[1]).toEqual(attempts[0]);
        expect(attempts[0].path).toBe(`/api/v2/jobs/${failedJob.id}/retry`);
        expect(attempts[0].body).toBeUndefined();
      },
      {
        initialBatch: batch("failed", 1, [failedJob]),
        selected: media,
        exportResponses: [],
        retryResponses: [
          Response.json(
            {
              error: {
                code: "upstream_timeout",
                message: "Try again.",
                requestId: "r-retry-timeout",
              },
            },
            { status: 500 },
          ),
          Response.json(batch("queued", 0.1, [job("j_exportretry0001", "queued", 1)]), {
            status: 202,
          }),
        ],
        onRetryRequest: (request) => attempts.push(request),
        onApiRequest: (path) => {
          if (path.endsWith("/events")) events.push(path);
        },
      },
    );
  });

  it("preserves generated capacity errors and uses a fresh key for each definite-failure retry", async () => {
    const keys: string[] = [];
    const events: string[] = [];
    await withExportController(
      batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 2)]),
      async (controller) => {
        // Terminal seeds are workspace snapshots, not a reason to open SSE.
        expect(events).toHaveLength(0);
        const initialEventRequests = events.length;
        await submitExport(controller);
        expect(controller.exportStatus()).toBe("Export capacity is busy. Try again shortly.");
        expect(controller.exportPending()).toBe(false);
        await submitExport(controller);
        expect(controller.exportStatus()).toBe("Export capacity is busy. Try again shortly.");
        expect(new Set(keys).size).toBe(2);
        expect(events).toHaveLength(initialEventRequests);
      },
      {
        initialBatch: batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 1)]),
        selected: media,
        projectItems: [exportItem(media)],
        dirty: false,
        exportResponses: [1, 2].map(() =>
          Response.json(
            {
              error: {
                code: "export_busy",
                message: "Export capacity is full.",
                requestId: "r-capacity",
              },
            },
            { status: 429 },
          ),
        ),
        onExportHeaders: (headers) => keys.push(headers.get("Idempotency-Key") ?? ""),
        onApiRequest: (path) => {
          if (path.endsWith("/events")) events.push(path);
        },
      },
    );
  });
  it("deduplicates keyed batch and child cancellations while distinct targets run independently", async () => {
    const active = batch("running", 0.5, [
      job("j_cancelone0001", "running", 1),
      job("j_canceltwo0002", "queued", 1),
    ]);
    const requests = new Map<string, (response: Response) => void>();
    await withExportController(
      active,
      async (controller, { registry }) => {
        await vi.waitFor(() => expect(controller.batchId()).toBe(batchId));
        controller.cancelChildJob("j_cancelone0001");
        controller.cancelChildJob("j_cancelone0001");
        controller.cancelChildJob("j_canceltwo0002");
        controller.cancelExport();
        controller.cancelBatch(batchId);
        await vi.waitFor(() => expect(requests.size).toBe(3));
        expect(controller.childJobPending("j_cancelone0001")).toBe(true);
        expect(controller.exportCancellationPending()).toBe(true);
        expect(controller.batchJobs().every((item) => item.state === "cancelled")).toBe(true);
        for (const [path, respond] of requests) {
          respond(new Response(null, { status: 204 }));
          const target = path.includes("/batches/")
            ? `batch:${batchId}`
            : `job:${path.split("/").at(-1)}`;
          await Effect.runPromise(
            AtomRegistry.getResult(registry, controller.cancellationCommands(target), {
              suspendOnWaiting: true,
            }),
          );
        }
        expect(controller.childJobPending("j_cancelone0001")).toBe(false);
        expect(controller.exportCancellationPending()).toBe(false);
      },
      {
        initialBatch: active,
        onBatchEvent: () => new Promise(() => {}),
        onCancellation: (path) =>
          new Promise((resolve) => {
            if (requests.has(path)) throw new Error("Duplicate cancellation request");
            requests.set(path, resolve);
          }),
      },
    );
  });

  it("settles a failed child independently of a still-pending successful sibling", async () => {
    const active = batch("running", 0.5, [
      job("j_cancelfailure01", "running", 1),
      job("j_cancelsuccess01", "running", 1),
    ]);
    const responses = new Map<string, (response: Response) => void>();
    await withExportController(
      active,
      async (controller, { registry }) => {
        await vi.waitFor(() => expect(controller.batchId()).toBe(batchId));
        controller.cancelChildJob("j_cancelfailure01");
        controller.cancelChildJob("j_cancelsuccess01");
        await vi.waitFor(() => expect(responses.size).toBe(2));
        responses.get("/api/v2/jobs/j_cancelfailure01")!(
          Response.json(
            { error: { code: "failed", message: "private", requestId: "request" } },
            { status: 500 },
          ),
        );
        await Effect.runPromise(
          AtomRegistry.getResult(
            registry,
            controller.cancellationCommands("job:j_cancelfailure01"),
            { suspendOnWaiting: true },
          ).pipe(Effect.exit),
        );
        expect(controller.batchJobs().map((item) => item.state)).toEqual(["running", "cancelled"]);
        expect(controller.childJobPending("j_cancelfailure01")).toBe(false);
        expect(controller.childJobPending("j_cancelsuccess01")).toBe(true);
        responses.get("/api/v2/jobs/j_cancelsuccess01")!(new Response(null, { status: 204 }));
        await Effect.runPromise(
          AtomRegistry.getResult(
            registry,
            controller.cancellationCommands("job:j_cancelsuccess01"),
            { suspendOnWaiting: true },
          ),
        );
        expect(controller.childJobPending("j_cancelsuccess01")).toBe(false);
      },
      {
        initialBatch: active,
        onBatchEvent: () => new Promise(() => {}),
        onCancellation: (path) =>
          new Promise((resolve) => {
            responses.set(path, resolve);
          }),
      },
    );
  });

  it.each(["batch", "job"] as const)(
    "rolls back rejected %s cancellation and permits retry",
    async (kind) => {
      const active = batch("running", 0.5, [job("j_cancelrollback", "running", 1)]);
      let attempts = 0;
      await withExportController(
        active,
        async (controller, { registry }) => {
          await vi.waitFor(() => expect(controller.batchId()).toBe(batchId));
          const cancel = () =>
            kind === "batch"
              ? controller.cancelBatch(batchId)
              : controller.cancelChildJob("j_cancelrollback");
          const target = kind === "batch" ? `batch:${batchId}` : "job:j_cancelrollback";
          cancel();
          await Effect.runPromise(
            AtomRegistry.getResult(registry, controller.cancellationCommands(target), {
              suspendOnWaiting: true,
            }).pipe(Effect.exit),
          );
          expect(controller.batchJobs()[0].state).toBe("running");
          expect(controller.exportStatus()).toContain("could not be cancelled. Try again.");
          expect(controller.exportStatus()).not.toContain("private");
          cancel();
          await Effect.runPromise(
            AtomRegistry.getResult(registry, controller.cancellationCommands(target), {
              suspendOnWaiting: true,
            }),
          );
          expect(attempts).toBe(2);
          expect(controller.batchJobs()[0].state).toBe("cancelled");
        },
        {
          initialBatch: active,
          onBatchEvent: () => new Promise(() => {}),
          onCancellation: async () =>
            ++attempts === 1
              ? Response.json(
                  { error: { code: "failed", message: "private", requestId: "request" } },
                  { status: 500 },
                )
              : new Response(null, { status: 204 }),
        },
      );
    },
  );

  it("context change releases a cancellation request without allowing its late failure notice", async () => {
    const active = batch("running", 0.5, [job("j_cancelcontext", "running", 1)]);
    let signal: AbortSignal | undefined;
    let respond!: (response: Response) => void;
    await withExportController(
      active,
      async (controller, { updateContext, registry }) => {
        await vi.waitFor(() => expect(controller.batchId()).toBe(batchId));
        controller.cancelChildJob("j_cancelcontext");
        await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
        updateContext({ projectId: "p_replacement", generation: 2 });
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        expect(registry.get(controller.cancellationCommands("job:j_cancelcontext")).waiting).toBe(
          false,
        );
        controller.clearExportContext();
        respond(
          Response.json(
            { error: { code: "failed", message: "old failure", requestId: "request" } },
            { status: 500 },
          ),
        );
        await Promise.resolve();
        expect(controller.exportStatus()).toBe("");
      },
      {
        initialBatch: active,
        onBatchEvent: () => new Promise(() => {}),
        onCancellation: (_path, requestSignal) => {
          signal = requestSignal;
          return new Promise((resolve) => {
            respond = resolve;
          });
        },
      },
    );
  });
  it("new export releases a pending cancellation and ignores its late rejection", async () => {
    const active = batch("running", 0.5, [job("j_oldcancelpending", "running", 1)]);
    const replacement = "b_newcancelpending";
    let respond!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    await withExportController(
      active,
      async (controller) => {
        await vi.waitFor(() => expect(controller.batchId()).toBe(batchId));
        controller.cancelExport();
        await vi.waitFor(() => expect(respond).toBeTypeOf("function"));
        await submitExport(controller);
        expect(signal?.aborted).toBe(true);
        expect(controller.batchId()).toBe(replacement);
        expect(controller.exportStatus()).toBe("Export queued.");
        respond(
          Response.json(
            { error: { code: "failed", message: "old failure", requestId: "request" } },
            { status: 500 },
          ),
        );
        await Promise.resolve();
        expect(controller.batchId()).toBe(replacement);
        expect(controller.exportStatus()).toBe("Export queued.");
      },
      {
        initialBatch: active,
        selected: media,
        projectItems: [exportItem(media)],
        onBatchEvent: () => new Promise(() => {}),
        onCancellation: (_path, requestSignal) => {
          signal = requestSignal;
          return new Promise((resolve) => {
            respond = resolve;
          });
        },
        exportResponses: [
          Response.json(
            {
              batchId: replacement,
              jobs: [{ ...job("j_newcancelpending", "queued", 1), batchId: replacement }],
            },
            { status: 202 },
          ),
        ],
      },
    );
  });

  it("keeps replacement ownership after consuming a cancelled batch's late terminal snapshot", async () => {
    const oldBatchId = "b_oldreplacement001";
    const newBatchId = "b_newreplacement001";
    const oldJob: Job = { ...job("j_oldreplacement001", "queued", 1), batchId: oldBatchId };
    const newJob: Job = { ...job("j_newreplacement001", "queued", 1), batchId: newBatchId };
    const oldTerminal: Batch = {
      ...batch("succeeded", 1, [
        {
          ...oldJob,
          state: "succeeded",
          revision: 2,
          progress: 1,
          result: {
            outputName: "late-old-export.mkv",
            sizeBytes: 42,
            retainUntil: "2026-08-20T12:00:00Z",
            destinationKind: "download",
          },
          verified: true,
        },
      ]),
      batchId: oldBatchId,
    };
    let signalDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => (signalDeleteStarted = resolve));
    let releaseDeleteAck!: () => void;
    const deleteAck = new Promise<void>((resolve) => (releaseDeleteAck = resolve));
    let signalOldEventStarted!: () => void;
    const oldEventStarted = new Promise<void>((resolve) => (signalOldEventStarted = resolve));
    let releaseOldTerminal!: () => void;
    const oldTerminalRelease = new Promise<void>((resolve) => (releaseOldTerminal = resolve));
    let signalOldTerminalDelivered!: () => void;
    const oldTerminalDelivered = new Promise<void>(
      (resolve) => (signalOldTerminalDelivered = resolve),
    );
    let resolveBatchList!: (response: Response) => void;
    const batchListResponse = new Promise<Response>((resolve) => (resolveBatchList = resolve));
    const streamResponse = (snapshot: Batch) =>
      new Response(
        [
          "id: late-replacement-snapshot",
          "event: snapshot",
          `data: ${JSON.stringify(snapshot)}`,
          "",
          "",
        ].join("\n"),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    await withExportController(
      batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 2)]),
      async (controller) => {
        const deadline = Date.now() + 2_000;
        while (controller.preflightPending()) {
          if (Date.now() >= deadline) throw new Error("Initial preflight did not finish.");
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        await submitExport(controller);
        await oldEventStarted;
        controller.cancelExport();
        const cancellation = Effect.runPromise(
          AtomRegistry.getResult(
            exportRegistries.get(controller)!,
            controller.cancellationCommands(`batch:${oldBatchId}`),
            { suspendOnWaiting: true },
          ),
        );
        await deleteStarted;
        releaseDeleteAck();
        await cancellation;
        await submitExport(controller);
        expect(controller.batchId()).toBe(newBatchId);
        expect(controller.batchJobs().map(({ id }) => id)).toEqual([newJob.id]);
        resolveBatchList(
          Response.json({
            items: [
              {
                ...batch("queued", 0, [oldJob]),
                batchId: oldBatchId,
                projectId: "p_exportstatus0001",
              },
              {
                ...batch("queued", 0, [newJob]),
                batchId: newBatchId,
                projectId: "p_exportstatus0001",
              },
            ],
            nextCursor: null,
          }),
        );

        releaseOldTerminal();
        await oldTerminalDelivered;
        const settledDeadline = Date.now() + 2_000;
        let consumedOldTerminal: Batch | undefined;
        while (!consumedOldTerminal?.jobs[0]?.result) {
          consumedOldTerminal = controller.batches().find(({ batchId }) => batchId === oldBatchId);
          if (Date.now() >= settledDeadline)
            throw new Error(
              "The old terminal snapshot was delivered but not consumed by its atom.",
            );
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(consumedOldTerminal.jobs[0]?.result?.outputName).toBe("late-old-export.mkv");
        expect(controller.batchId()).toBe(newBatchId);
        expect(controller.batchJobs().map(({ id }) => id)).toEqual([newJob.id]);
        expect(
          controller.batchJobs().some(({ result }) => result?.outputName === "late-old-export.mkv"),
        ).toBe(false);
      },
      {
        initialBatch: batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 1)]),
        batchListResponse,
        selected: media,
        projectItems: [exportItem(media)],
        exportResponses: [
          Response.json({ batchId: oldBatchId, jobs: [oldJob] }, { status: 202 }),
          Response.json({ batchId: newBatchId, jobs: [newJob] }, { status: 202 }),
        ],
        onRequest: (method, path) => {
          if (method === "DELETE" && path === `/api/v2/batches/${oldBatchId}`) {
            signalDeleteStarted();
            return deleteAck;
          }
        },
        onBatchEvent: async (path) => {
          if (path === `batches/${oldBatchId}/events`) {
            signalOldEventStarted();
            await oldTerminalRelease;
            signalOldTerminalDelivered();
            return streamResponse(oldTerminal);
          }
          const snapshot = {
            ...batch("queued", 0, [newJob]),
            batchId: newBatchId,
            projectId: "p_exportstatus0001",
          };
          return streamResponse(snapshot);
        },
      },
    );
  });
  it("shows a generated preflight error and does not submit the export", async () => {
    const calls: string[] = [];
    await withExportController(
      batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 2)]),
      async (controller) => {
        await submitExport(controller);
        expect(calls).toEqual(["save", "preflight"]);
        expect(controller.preflightError()).toBe(
          "Export preflight failed (invalid_export): No playable streams. (request r-preflight)",
        );
      },
      {
        initialBatch: batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 1)]),
        selected: media,
        projectItems: [exportItem(media)],
        dirty: true,
        revision: 2,
        onRequest: (method, path) => {
          if (method === "POST") calls.push(path.endsWith("/preflight") ? "preflight" : "submit");
        },
        preflightFailure: {
          code: "invalid_export",
          message: "No playable streams.",
          requestId: "r-preflight",
        },
        saveProject: () =>
          Effect.sync(() => {
            calls.push("save");
            return {
              id: "p_exportstatus0001",
              name: "Saved",
              revision: 2,
              updatedAt: timestamp,
              schemaVersion: 2,
              items: [],
            };
          }),
      },
    );
  });
  it.each([
    [
      "reports failure when an earlier child succeeded",
      batch("failed", 1, [
        job("j_exportstatus0001", "succeeded", 2),
        job("j_exportstatus0002", "failed", 2, "mux_failed"),
      ]),
      "Export failed: mux_failed.",
    ],
    [
      "reports completion when all children succeeded",
      batch("succeeded", 1, [
        job("j_exportstatus0001", "succeeded", 2),
        job("j_exportstatus0002", "succeeded", 2),
      ]),
      "Export complete.",
    ],
    [
      "reports the running batch while a later child is active",
      batch("running", 0.45, [
        job("j_exportstatus0001", "succeeded", 2),
        job("j_exportstatus0002", "running", 2),
      ]),
      "Export batch running (45%).",
    ],
    [
      "reports cancellation when a later child was cancelled",
      batch("cancelled", 1, [
        job("j_exportstatus0001", "succeeded", 2),
        job("j_exportstatus0002", "cancelled", 2),
      ]),
      "Export cancelled.",
    ],
  ])("%s", async (_name, terminalBatch, expectedStatus) => {
    await withExportController(terminalBatch, async (controller) => {
      await waitForStatus(controller, expectedStatus);
      expect(controller.exportStatus()).toBe(expectedStatus);
    });
  });
});

const preflightMedia: EffectApiTypes.Media = {
  id: `m_${"m".repeat(43)}`,
  name: "preflight.mkv",
  durationMs: 2000,
  sizeBytes: 1,
  container: "mkv",
  streams: {},
  etag: "v1",
};
const schedulerTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const allowedPreflight = () => Response.json({ allowed: true, selection: [], findings: [] });
const deniedPreflight = () =>
  Response.json({
    allowed: false,
    selection: [],
    findings: [
      { severity: "blocked", code: "unsupported_stream", message: "Choose another stream." },
    ],
  });
function controlledPreflights() {
  const requests: Array<{
    path: string;
    input: EffectApiTypes.ExportInput;
    signal: AbortSignal | undefined;
    resolve: (response: Response) => void;
  }> = [];
  const onPreflightRequest: NonNullable<
    Parameters<typeof withExportController>[2]
  >["onPreflightRequest"] = (request) =>
    new Promise<Response>((resolve) => requests.push({ ...request, resolve }));
  return { requests, onPreflightRequest };
}

describe("export preflight resource", () => {
  it("debounces options and context changes, interrupts obsolete checks, and rejects late results", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { requests, onPreflightRequest } = controlledPreflights();
    try {
      await withExportController(
        batch("succeeded", 1, []),
        async (controller, controls) => {
          await schedulerTurn();
          expect(controller.preflightPending()).toBe(true);
          await vi.advanceTimersByTimeAsync(249);
          expect(requests).toHaveLength(0);
          controller.setExportMode("separate");
          controller.setStreamIndexes([2]);
          await schedulerTurn();
          await vi.advanceTimersByTimeAsync(249);
          expect(requests).toHaveLength(0);
          await vi.advanceTimersByTimeAsync(1);
          expect(requests).toHaveLength(1);
          expect(requests[0].input).toMatchObject({ mode: "separate", streamIndexes: [2] });

          controller.setFilenameTemplate("{source}.{ext}");
          await schedulerTurn();
          expect(requests[0].signal?.aborted).toBe(true);
          expect(controller.preflight()).toBeUndefined();
          await vi.advanceTimersByTimeAsync(250);
          expect(requests).toHaveLength(2);
          requests[1].resolve(deniedPreflight());
          await schedulerTurn();
          expect(controller.preflightPending()).toBe(false);
          expect(controller.preflight()).toMatchObject({ allowed: false });
          requests[0].resolve(allowedPreflight());
          await schedulerTurn();
          expect(controller.preflight()).toMatchObject({ allowed: false });

          controls.updateContext({
            projectId: "p_otherproject0001",
            revision: 3,
            editVersion: 4,
            generation: 1,
          });
          expect(controller.preflight()).toBeUndefined();
          await schedulerTurn();
          await vi.advanceTimersByTimeAsync(250);
          expect(requests).toHaveLength(3);
          expect(requests[2].path).toBe("/api/v2/projects/p_otherproject0001/exports/preflight");
          requests[2].resolve(allowedPreflight());
          await schedulerTurn();
          expect(AsyncResult.isSuccess(controller.preflightResult())).toBe(true);
          expect(controller.preflight()?.allowed).toBe(true);
          controls.setNotice("A workspace notice is not an edit.");
          await vi.advanceTimersByTimeAsync(1000);
          expect(requests).toHaveLength(3);
          expect(controller.preflight()?.allowed).toBe(true);
        },
        {
          selected: preflightMedia,
          projectItems: [exportItem(preflightMedia)],
          onPreflightRequest,
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears obsolete checks for dirty and empty selections without automatically requesting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { requests, onPreflightRequest } = controlledPreflights();
    try {
      await withExportController(
        batch("succeeded", 1, []),
        async (controller, controls) => {
          await schedulerTurn();
          await vi.advanceTimersByTimeAsync(250);
          requests[0].resolve(allowedPreflight());
          await schedulerTurn();
          expect(controller.preflight()?.allowed).toBe(true);
          controls.updateContext({ dirty: true, editVersion: 1 });
          expect(controller.preflight()).toBeUndefined();
          expect(controller.preflightError()).toBe("");
          expect(controller.preflightPending()).toBe(false);
          await vi.advanceTimersByTimeAsync(1000);
          expect(requests).toHaveLength(1);
          controls.updateContext({ dirty: false });
          await schedulerTurn();
          await vi.advanceTimersByTimeAsync(250);
          expect(requests).toHaveLength(2);
          controller.chooseExportScope("selected");
          controller.chooseExportItems([]);
          await schedulerTurn();
          expect(requests[1].signal?.aborted).toBe(true);
          expect(controller.preflightPending()).toBe(false);
          requests[1].resolve(deniedPreflight());
          await vi.advanceTimersByTimeAsync(1000);
          expect(controller.preflight()).toBeUndefined();
          expect(controller.preflightError()).toBe("");
          expect(requests).toHaveLength(2);
          controller.chooseExportItems([controls.items()[0].id]);
          await schedulerTurn();
          await vi.advanceTimersByTimeAsync(250);
          requests[2].resolve(allowedPreflight());
          await schedulerTurn();
          expect(controller.preflight()?.allowed).toBe(true);
          controls.replaceItems([]);
          expect(controller.preflight()).toBeUndefined();
          await vi.advanceTimersByTimeAsync(1000);
          expect(requests).toHaveLength(3);
        },
        {
          selected: preflightMedia,
          projectItems: [exportItem(preflightMedia)],
          onPreflightRequest,
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives native failures, preserves server denials, and allows a successful retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { requests, onPreflightRequest } = controlledPreflights();
    try {
      await withExportController(
        batch("succeeded", 1, []),
        async (controller) => {
          await schedulerTurn();
          await vi.advanceTimersByTimeAsync(250);
          requests[0].resolve(
            Response.json(
              {
                error: {
                  code: "invalid_export",
                  message: "No playable streams.",
                  requestId: "r-preflight",
                },
              },
              { status: 400 },
            ),
          );
          await schedulerTurn();
          expect(AsyncResult.isFailure(controller.preflightResult())).toBe(true);
          expect(controller.preflightPending()).toBe(false);
          expect(controller.preflight()).toBeUndefined();
          expect(controller.preflightError()).toBe(
            "Export preflight failed (invalid_export): No playable streams. (request r-preflight)",
          );
          controller.retryPreflight();
          expect(controller.preflightError()).toBe("");
          expect(controller.preflightPending()).toBe(true);
          await schedulerTurn();
          await vi.advanceTimersByTimeAsync(250);
          requests[1].resolve(deniedPreflight());
          await schedulerTurn();
          expect(controller.preflight()).toMatchObject({
            allowed: false,
            findings: [
              {
                severity: "blocked",
                code: "unsupported_stream",
                message: "Choose another stream.",
              },
            ],
          });
          expect(controller.preflightError()).toBe("");
          controller.retryPreflight();
          expect(controller.preflight()).toBeUndefined();
          await schedulerTurn();
          await vi.advanceTimersByTimeAsync(250);
          requests[2].resolve(allowedPreflight());
          await schedulerTurn();
          expect(controller.preflightPending()).toBe(false);
          expect(controller.preflightError()).toBe("");
          expect(controller.preflight()?.allowed).toBe(true);
        },
        {
          selected: preflightMedia,
          projectItems: [exportItem(preflightMedia)],
          onPreflightRequest,
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands an in-flight automatic check to fresh submission without competing mutations", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { requests, onPreflightRequest } = controlledPreflights();
    const submissions: string[] = [];
    try {
      await withExportController(
        batch("succeeded", 1, []),
        async (controller) => {
          await schedulerTurn();
          await vi.advanceTimersByTimeAsync(250);
          expect(requests).toHaveLength(1);
          const exporting = submitExport(controller);
          await schedulerTurn();
          expect(requests).toHaveLength(2);
          expect(requests[0].signal?.aborted).toBe(true);
          expect(controller.preflightPending()).toBe(true);
          controller.retryPreflight();
          await vi.advanceTimersByTimeAsync(1000);
          expect(requests).toHaveLength(2);
          requests[1].resolve(deniedPreflight());
          await exporting;
          expect(controller.preflightPending()).toBe(false);
          expect(controller.preflight()?.allowed).toBe(false);
          expect(submissions).toEqual([]);
          requests[0].resolve(allowedPreflight());
          await vi.advanceTimersByTimeAsync(1000);
          expect(controller.preflight()?.allowed).toBe(false);
          expect(requests).toHaveLength(2);
        },
        {
          selected: preflightMedia,
          projectItems: [exportItem(preflightMedia)],
          initialBatch: batch("succeeded", 1, []),
          onPreflightRequest,
          onExportHeaders: (_headers, _body, target) => submissions.push(target),
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits a fresh check immediately instead of sending the pending debounce", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { requests, onPreflightRequest } = controlledPreflights();
    try {
      await withExportController(
        batch("succeeded", 1, []),
        async (controller) => {
          await schedulerTurn();
          expect(requests).toHaveLength(0);
          const exporting = submitExport(controller);
          await schedulerTurn();
          expect(requests).toHaveLength(1);
          requests[0].resolve(deniedPreflight());
          await exporting;
          await vi.advanceTimersByTimeAsync(1000);
          expect(requests).toHaveLength(1);
          expect(controller.preflight()?.allowed).toBe(false);
        },
        {
          selected: preflightMedia,
          projectItems: [exportItem(preflightMedia)],
          initialBatch: batch("succeeded", 1, []),
          onPreflightRequest,
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts a fresh submission check when its edit context changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { requests, onPreflightRequest } = controlledPreflights();
    let submits = 0;
    try {
      await withExportController(
        batch("succeeded", 1, []),
        async (controller, controls) => {
          const exporting = submitExport(controller);
          await schedulerTurn();
          expect(requests).toHaveLength(1);
          controls.updateContext({ dirty: true, editVersion: 1 });
          await exporting;
          expect(requests[0].signal?.aborted).toBe(true);
          requests[0].resolve(allowedPreflight());
          await vi.advanceTimersByTimeAsync(1000);
          expect(requests).toHaveLength(1);
          expect(controller.preflight()).toBeUndefined();
          expect(controller.preflightPending()).toBe(false);
          expect(controller.preflightError()).toBe("");
          expect(submits).toBe(0);
          expect(controller.exportStatus()).toBe(
            "Create clips stopped because the project changed. Save again and retry.",
          );
        },
        {
          selected: preflightMedia,
          projectItems: [exportItem(preflightMedia)],
          initialBatch: batch("succeeded", 1, []),
          onPreflightRequest,
          onExportHeaders: () => {
            submits++;
          },
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts the owned check on disposal without publishing a late response", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { requests, onPreflightRequest } = controlledPreflights();
    try {
      await withExportController(
        batch("succeeded", 1, []),
        async (_controller, controls) => {
          await schedulerTurn();
          await vi.advanceTimersByTimeAsync(250);
          expect(requests).toHaveLength(1);
          controls.dispose();
          await schedulerTurn();
          expect(requests[0].signal?.aborted).toBe(true);
          requests[0].resolve(allowedPreflight());
          await schedulerTurn();
          expect(controls.registry.getNodes().size).toBe(0);
          expect(requests).toHaveLength(1);
        },
        {
          selected: preflightMedia,
          projectItems: [exportItem(preflightMedia)],
          onPreflightRequest,
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
