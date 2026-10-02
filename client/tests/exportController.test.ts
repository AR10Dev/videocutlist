import { RegistryContext, RegistryProvider } from "@effect/atom-solid";
import { createComponent, createRoot, createSignal, untrack, useContext } from "solid-js";
import { describe, expect, it } from "vitest";
import type { ApiClient, NativeMediaApiClient } from "../src/api";
import { createServerState } from "../src/features/app/server";
import { createExportController } from "../src/features/export/controller";
import { createTimelineHistory } from "../src/features/editor/timeline";
import type { EditableProjectItem } from "../src/features/projects/model";
import { defaultSettings } from "../src/features/settings/model";
import type { components } from "../src/generated/api";

const batchId = "b_exportstatus0001";
const timestamp = "2026-01-01T00:00:00Z";

type Batch = components["schemas"]["Batch"];
type Job = components["schemas"]["Job"];
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
const exportItem = (media: components["schemas"]["Media"]): EditableProjectItem => ({
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
    selected?: components["schemas"]["Media"];
    projectItems?: EditableProjectItem[];
    dirty?: boolean;
    revision?: number;
    saveProject?: () => Promise<components["schemas"]["Project"] | undefined>;
    onRequest?: (method: string, path: string) => void;
    preflightFailure?: components["schemas"]["Error"]["error"];
    batchListResponse?: Promise<Response>;
    destinationsResponse?: Promise<Response>;
  } = {},
) {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalFetch = globalThis.fetch;
  const initialBatch =
    options.initialBatch ??
    batch("running", 0.4, [
      job("j_exportstatus0001", "succeeded", 1),
      job("j_exportstatus0002", "running", 1),
    ]);
  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    options.onRequest?.(method, requestUrl.pathname);
    if (requestUrl.pathname === "/api/v2/batches" && method === "GET")
      return (
        options.batchListResponse ??
        Promise.resolve(Response.json({ items: [initialBatch], nextCursor: null }))
      );
    if (requestUrl.pathname === "/api/v2/destinations")
      return (
        options.destinationsResponse ??
        Promise.resolve(
          Response.json({ destinations: [], capabilities: { saveBesideSource: false } }),
        )
      );
    if (requestUrl.pathname.endsWith("/exports/preflight") && method === "POST")
      return options.preflightFailure
        ? Response.json({ error: options.preflightFailure }, { status: 400 })
        : Response.json({ allowed: true, selection: [], findings: [] });
    if (requestUrl.pathname.endsWith("/exports") && method === "POST")
      return Response.json(
        {
          batchId,
          jobs: [job("j_exportfresh0001", "queued", 1)],
        },
        { status: 202 },
      );
    throw new Error(`Unexpected generated API request: ${method} ${requestUrl}`);
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
  const api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest"> = {
    url: (path) => path,
    request: async (path, init) => {
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
            api,
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
    const media: components["schemas"]["Media"] = {
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
  it("shows a generated preflight error and does not submit the export", async () => {
    const media: components["schemas"]["Media"] = {
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
