import { RegistryContext, RegistryProvider } from "@effect/atom-solid";
import { createComponent, createRoot, createSignal, untrack, useContext } from "solid-js";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "../src/api";
import { createServerState } from "../src/features/app/server";
import { createExportController } from "../src/features/export/controller";
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
) {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
  const initialBatch = batch("running", 0.4, [
    job("j_exportstatus0001", "succeeded", 1),
    job("j_exportstatus0002", "running", 1),
  ]);
  const api: ApiClient = {
    url: (path) => path,
    request: async (path, init) => {
      if (path === "batches?limit=50")
        return Response.json({ items: [initialBatch], nextCursor: null });
      if (path === "destinations")
        return Response.json({ destinations: [], capabilities: { saveBesideSource: false } });
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
          const [dirty, setDirty] = createSignal(false);
          const [projectItems, setProjectItems] = createSignal<EditableProjectItem[]>([]);
          controller = createExportController({
            api,
            server: createServerState(api, registry, configuration),
            selected: () => undefined,
            projectId: () => "p_exportstatus0001",
            revision: () => 1,
            dirty,
            setDirty,
            editorVersion: () => 0,
            status: () => "",
            projectItems,
            setProjectItems,
            activeItemId: () => undefined,
            editableItems: () => [],
            segments: () => [],
            tracks: () => [],
            saveProject: async () => undefined,
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
