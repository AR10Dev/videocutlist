import type * as EffectApiTypes from "../src/generated/effect-api";
import { RegistryContext, RegistryProvider } from "@effect/atom-solid";
import { createComponent, createRoot, createSignal, untrack, useContext } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, NativeMediaApiClient } from "../src/api";
import { createServerState } from "../src/features/app/server";
import { createExportController } from "../src/features/export/controller";
import { createTimelineHistory } from "../src/features/editor/timeline";
import type { EditableProjectItem } from "../src/features/projects/model";
import { defaultSettings } from "../src/features/settings/model";

const batchId = "b_exportstatus0001";
const timestamp = "2026-01-01T00:00:00Z";

type Batch = EffectApiTypes.Batch;
type Job = EffectApiTypes.Job;
type ExportController = ReturnType<typeof createExportController>;

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

async function withExportController(
  terminalBatch: Batch,
  exercise: (controller: ExportController) => Promise<void>,
  options: {
    initialBatch?: Batch;
    selected?: EffectApiTypes.Media;
    projectItems?: EditableProjectItem[];
    dirty?: boolean;
    revision?: number;
    saveProject?: () => Promise<EffectApiTypes.Project | undefined>;
    onRequest?: (method: string, path: string) => void | Promise<void>;
    preflightFailure?: EffectApiTypes.Error["error"];
    batchListResponse?: Promise<Response>;
    destinationsResponse?: Promise<Response>;
    nextDestinationsResponse?: () => Promise<Response>;
    exportResponses?: Response[];
    retryResponses?: Response[];
    onExportHeaders?: (headers: Headers, body: string | undefined) => void;
    onRetryRequest?: (request: { path: string; key: string; body: string | undefined }) => void;
    onApiRequest?: (path: string) => void;
    onBatchEvent?: (path: string, signal?: AbortSignal) => Promise<Response>;
  } = {},
) {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalFetch = globalThis.fetch;
  let destinationRequestCount = 0;
  const initialBatch =
    options.initialBatch ??
    batch("running", 0.4, [
      job("j_exportstatus0001", "succeeded", 1),
      job("j_exportstatus0002", "running", 1),
    ]);
  globalThis.fetch = async (input, init) => {
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
    if (method === "DELETE" && /^\/api\/v2\/batches\/[^/]+$/.test(requestUrl.pathname))
      return new Response(null, { status: 204 });
    if (requestUrl.pathname === "/api/v2/batches" && method === "GET")
      return (
        options.batchListResponse ??
        Promise.resolve(Response.json({ items: [initialBatch], nextCursor: null }))
      );
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
      return options.preflightFailure
        ? Response.json({ error: options.preflightFailure }, { status: 400 })
        : Response.json({ allowed: true, selection: [], findings: [] });
    if (/^\/api\/v2\/jobs\/[^/]+\/retry$/.test(requestUrl.pathname) && method === "POST") {
      options.onRetryRequest?.({
        path: requestUrl.pathname,
        key: headers.get("Idempotency-Key") ?? "",
        body,
      });
      const response = options.retryResponses?.shift();
      if (response) return response;
      return Response.json(batch("queued", 0.1, [job("j_exportretry0001", "queued", 1)]), {
        status: 202,
      });
    }
    if (requestUrl.pathname.endsWith("/exports") && method === "POST") {
      options.onExportHeaders?.(headers, body);
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
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
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
  const configuration = {
    serverBaseUrl: "http://localhost",
    authentication: { type: "none" as const },
  };
  let dispose!: () => void;
  let controller!: ExportController;
  createRoot((disposeRoot) => {
    dispose = disposeRoot;
    createComponent(RegistryProvider, {
      get children() {
        untrack(() => {
          const registry = useContext(RegistryContext);
          const [dirty, setDirty] = createSignal(options.dirty ?? false);
          const [projectItems, setProjectItems] = createSignal<EditableProjectItem[]>([]);
          controller = createExportController({
            server: createServerState(api, registry, configuration),
            selected: () => options.selected,
            projectId: () => "p_exportstatus0001",
            revision: () => options.revision ?? 1,
            dirty,
            setDirty,
            editorVersion: () => 0,
            status: () => "",
            projectItems: () => options.projectItems ?? projectItems(),
            setProjectItems,
            activeItemId: () => options.projectItems?.[0]?.id,
            editableItems: () => options.projectItems ?? projectItems(),
            segments: () => options.projectItems?.[0]?.timeline.present.segments ?? [],
            tracks: () => [],
            saveProject: options.saveProject ?? (async () => undefined),
            settings: () => defaultSettings,
            markDirty: () => undefined,
            saveSettings: () => undefined,
          });
        });
        return null;
      },
    });
  });
  try {
    await exercise(controller);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
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

describe("export controller aggregate status", () => {
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
    const media: EffectApiTypes.Media = {
      id: `m_${"m".repeat(43)}`,
      name: "clip.mp4",
      durationMs: 2_000,
      sizeBytes: 1,
      container: "mp4",
      streams: {},
      etag: "v1",
    };
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
        await controller.exportProject();
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
        saveProject: async () => {
          calls.push("save");
          return {
            id: "p_exportstatus0001",
            name: "Saved",
            revision: 2,
            updatedAt: timestamp,
            schemaVersion: 2,
            items: [],
          };
        },
      },
    );
  });
  it("redelivers an unfamiliar generated export failure with the same key and body", async () => {
    const media: EffectApiTypes.Media = {
      id: `m_${"m".repeat(43)}`,
      name: "clip.mp4",
      durationMs: 2_000,
      sizeBytes: 1,
      container: "mp4",
      streams: {},
      etag: "v1",
    };
    const attempts: Array<{ key: string; body: string | undefined }> = [];
    const events: string[] = [];
    await withExportController(
      batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 2)]),
      async (controller) => {
        await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
        await controller.exportProject();
        await controller.exportProject();
        expect(attempts).toHaveLength(2);
        expect(attempts[0].key).toBeTruthy();
        expect(attempts[1]).toEqual(attempts[0]);
        expect(JSON.parse(attempts[0].body ?? "{}")).toMatchObject({ projectRevision: 1 });
      },
      {
        initialBatch: batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 1)]),
        selected: media,
        projectItems: [exportItem(media)],
        dirty: false,
        exportResponses: [
          Response.json(
            {
              error: {
                code: "upstream_timeout",
                message: "Try again.",
                requestId: "r-export-timeout",
              },
            },
            { status: 500 },
          ),
          Response.json(
            { batchId, jobs: [job("j_exportfresh0001", "queued", 1)] },
            { status: 202 },
          ),
        ],
        onExportHeaders: (headers, body) =>
          attempts.push({ key: headers.get("Idempotency-Key") ?? "", body }),
        onApiRequest: (path) => {
          if (path.endsWith("/events")) events.push(path);
        },
      },
    );
  });

  it("redelivers an unfamiliar generated retry failure with the same key and operation", async () => {
    const media: EffectApiTypes.Media = {
      id: `m_${"m".repeat(43)}`,
      name: "clip.mp4",
      durationMs: 2_000,
      sizeBytes: 1,
      container: "mp4",
      streams: {},
      etag: "v1",
    };
    const failedJob = job("j_exportstatus0001", "failed", 1);
    const attempts: Array<{ path: string; key: string; body: string | undefined }> = [];
    const events: string[] = [];
    await withExportController(
      batch("failed", 1, [failedJob]),
      async (controller) => {
        await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
        await controller.retryChildJob(failedJob.id, batchId);
        await controller.retryChildJob(failedJob.id, batchId);
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
    const media: EffectApiTypes.Media = {
      id: `m_${"m".repeat(43)}`,
      name: "clip.mp4",
      durationMs: 2_000,
      sizeBytes: 1,
      container: "mp4",
      streams: {},
      etag: "v1",
    };
    const keys: string[] = [];
    const events: string[] = [];
    await withExportController(
      batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 2)]),
      async (controller) => {
        const deadline = Date.now() + 2_000;
        while (events.length === 0) {
          if (Date.now() >= deadline) throw new Error("Initial batch stream did not start.");
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const initialEventRequests = events.length;
        await controller.exportProject();
        expect(controller.exportStatus()).toBe("Export capacity is busy. Try again shortly.");
        expect(controller.exportPending()).toBe(false);
        await controller.exportProject();
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
  it("keeps replacement ownership after consuming a cancelled batch's late terminal snapshot", async () => {
    const media: EffectApiTypes.Media = {
      id: `m_${"m".repeat(43)}`,
      name: "clip.mp4",
      durationMs: 2_000,
      sizeBytes: 1,
      container: "mp4",
      streams: {},
      etag: "v1",
    };
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
        await controller.exportProject();
        await oldEventStarted;
        const cancellation = controller.cancelExport();
        await deleteStarted;
        releaseDeleteAck();
        await cancellation;
        await controller.exportProject();
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
    const media: EffectApiTypes.Media = {
      id: `m_${"m".repeat(43)}`,
      name: "clip.mp4",
      durationMs: 2_000,
      sizeBytes: 1,
      container: "mp4",
      streams: {},
      etag: "v1",
    };
    const calls: string[] = [];
    await withExportController(
      batch("succeeded", 1, [job("j_exportstatus0001", "succeeded", 2)]),
      async (controller) => {
        await controller.exportProject();
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
        saveProject: async () => {
          calls.push("save");
          return {
            id: "p_exportstatus0001",
            name: "Saved",
            revision: 2,
            updatedAt: timestamp,
            schemaVersion: 2,
            items: [],
          };
        },
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
