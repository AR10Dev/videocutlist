import { RegistryContext, RegistryProvider } from "@effect/atom-solid";
import {
  createComponent,
  createRoot,
  createSignal,
  untrack,
  useContext,
  type Accessor,
} from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import { createServerState } from "../src/features/app/server";
import { createLibraryController } from "../src/features/media/controller";
import type { components } from "../src/generated/api";

type LibrarySurface = {
  media: Accessor<components["schemas"]["Media"][]>;
  activeFolder: Accessor<string | undefined>;
  nextCursor: Accessor<string | undefined>;
  loadingMore: () => boolean;
  loadFolder: (folderId?: string, cursor?: string) => void;
  refreshMedia: () => Promise<void>;
  importJob: () => { id: string; state: string; indexed?: number } | undefined;
  scanActive: () => boolean;
  cancellingImport: () => boolean;
  cancelImport: () => Promise<void>;
};

const item = (name: string): components["schemas"]["Media"] => ({
  id: `m_${name.padEnd(43, "a")}`,
  name,
  durationMs: 1000,
  sizeBytes: 100,
  container: "mp4",
  streams: {},
  etag: "v1",
});

const page = (names: string[], nextCursor?: string) =>
  Response.json({
    folders: [
      { id: "folder-a", label: "Folder A" },
      { id: "folder-b", label: "Folder B" },
    ],
    items: names.map(item),
    nextCursor,
  });

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withLibrary(
  request: ApiClient["request"],
  exercise: (library: LibrarySurface) => Promise<void>,
  configuration?: Parameters<typeof createServerState>[2],
) {
  const api: ApiClient = {
    url: (path) => path,
    request,
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      createComponent(RegistryProvider, {
        get children() {
          untrack(() => {
            const registry = useContext(RegistryContext);
            const [, setStatus] = createSignal("");
            const library = createLibraryController(
              createServerState(api, registry, configuration),
              setStatus,
            );
            queueMicrotask(() => {
              void exercise(library).then(
                () => {
                  dispose();
                  resolve();
                },
                (error: unknown) => {
                  dispose();
                  reject(error);
                },
              );
            });
          });
          return null;
        },
      });
    });
  });
}

describe("library controller", () => {
  it("retains the key for uncertain scan redelivery and rotates it for a new command", async () => {
    const originalFetch = globalThis.fetch;
    const keys: string[] = [];
    let submits = 0;
    globalThis.fetch = async (_input, init) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (submits++ === 0) throw new TypeError("connection lost");
      if (submits === 2)
        return Response.json({ error: { code: "internal_error" } }, { status: 500 });
      return Response.json(
        { id: "j_abcdefghijkl", state: "queued", progress: 0, indexed: 0 },
        { status: 202 },
      );
    };
    try {
      await withLibrary(
        (path) => {
          if (path === "jobs/j_abcdefghijkl/events")
            return Promise.resolve(
              new Response(
                `event: snapshot\nid: cursor-1\ndata: ${JSON.stringify({
                  id: "j_abcdefghijkl",
                  type: "library_scan",
                  state: "succeeded",
                  revision: 1,
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:01Z",
                })}\n\n`,
                { headers: { "Content-Type": "text/event-stream" } },
              ),
            );
          if (path === "media/status")
            return Promise.resolve(Response.json({ state: "ready_empty", message: "Ready" }));
          return Promise.resolve(page(["root-video"]));
        },
        async (library) => {
          await library.refreshMedia();
          await library.refreshMedia();
          await library.refreshMedia();
          await vi.waitFor(() => expect(library.importJob()?.state).toBe("succeeded"));
          await library.refreshMedia();
          expect(keys).toHaveLength(4);
          expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
          expect(keys[1]).toBe(keys[0]);
          expect(keys[2]).toBe(keys[1]);
          expect(keys[3]).not.toBe(keys[2]);
        },
        { serverBaseUrl: "http://localhost", authentication: { type: "none" } },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps an accepted scan pending until its canonical SSE snapshot arrives", async () => {
    const originalFetch = globalThis.fetch;
    const observations: string[] = [];
    let pushSnapshot!: () => void;
    globalThis.fetch = async () =>
      Response.json(
        { id: "j_abcdefghijkl", state: "queued", progress: 0, indexed: 0 },
        { status: 202 },
      );
    try {
      await withLibrary(
        (path) => {
          if (path === "jobs/j_abcdefghijkl/events") {
            observations.push(path);
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                pushSnapshot = () =>
                  controller.enqueue(
                    encoder.encode(
                      `event: snapshot\nid: cursor-1\ndata: ${JSON.stringify({
                        id: "j_abcdefghijkl",
                        type: "library_scan",
                        state: "running",
                        revision: 1,
                        progress: 0.5,
                        indexed: 12,
                        createdAt: "2026-01-01T00:00:00Z",
                        updatedAt: "2026-01-01T00:00:01Z",
                      })}\n\n`,
                    ),
                  );
              },
            });
            return Promise.resolve(
              new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
            );
          }
          if (path.startsWith("jobs/")) observations.push(path);
          if (path === "media/status")
            return Promise.resolve(Response.json({ state: "ready_empty", message: "Ready" }));
          return Promise.resolve(page(["root-video"]));
        },
        async (library) => {
          await library.refreshMedia();
          expect(library.importJob()).toBeUndefined();
          expect(library.scanActive()).toBe(true);
          expect(library.cancellingImport()).toBe(true);
          pushSnapshot();
          await vi.waitFor(() => expect(library.importJob()?.state).toBe("running"));
          expect(library.importJob()?.indexed).toBe(12);
          expect(library.scanActive()).toBe(true);
          expect(library.cancellingImport()).toBe(false);
          expect(observations).toEqual(["jobs/j_abcdefghijkl/events"]);
        },
        { serverBaseUrl: "http://localhost", authentication: { type: "none" } },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts a newer scan snapshot after cancellation fails", async () => {
    const originalFetch = globalThis.fetch;
    let pushSnapshot!: (revision: number, indexed: number) => void;
    globalThis.fetch = async (_input, init) => {
      if (new Headers(init?.headers).has("Idempotency-Key"))
        return Response.json(
          { id: "j_abcdefghijkl", state: "queued", progress: 0, indexed: 0 },
          { status: 202 },
        );
      return Response.json({ error: { code: "internal_error" } }, { status: 500 });
    };
    try {
      await withLibrary(
        (path) => {
          if (path === "jobs/j_abcdefghijkl/events") {
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                const send = (revision: number, indexed: number) => {
                  controller.enqueue(
                    encoder.encode(
                      `event: snapshot\nid: cursor-${revision}\ndata: ${JSON.stringify({
                        id: "j_abcdefghijkl",
                        type: "library_scan",
                        state: "running",
                        revision,
                        progress: 0.5,
                        indexed,
                        createdAt: "2026-01-01T00:00:00Z",
                        updatedAt: `2026-01-01T00:00:0${revision}Z`,
                      })}\n\n`,
                    ),
                  );
                };
                pushSnapshot = send;
                send(1, 1);
              },
            });
            return Promise.resolve(
              new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
            );
          }
          if (path === "media/status")
            return Promise.resolve(Response.json({ state: "ready_empty", message: "Ready" }));
          return Promise.resolve(page(["root-video"]));
        },
        async (library) => {
          await library.refreshMedia();
          await vi.waitFor(() => expect(library.importJob()?.state).toBe("running"));
          await library.cancelImport();
          pushSnapshot(2, 9);
          await vi.waitFor(() => expect(library.importJob()?.indexed).toBe(9));
        },
        { serverBaseUrl: "http://localhost", authentication: { type: "none" } },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not show a previous folder when its request completes after navigation", async () => {
    const olderFolder = deferredResponse();
    let folderRequested!: () => void;
    const started = new Promise<void>((resolve) => {
      folderRequested = resolve;
    });
    await withLibrary(
      (path) => {
        if (path === "media/tree?folderId=folder-a") {
          folderRequested();
          return olderFolder.promise;
        }
        if (path === "media/tree?folderId=folder-b")
          return Promise.resolve(page(["folder-b-video"]));
        if (path === "media/status")
          return Promise.resolve(Response.json({ state: "ready", message: "Ready" }));
        return Promise.resolve(page(["root-video"]));
      },
      async (library) => {
        await vi.waitFor(() =>
          expect(library.media().map((media) => media.name)).toEqual(["root-video"]),
        );
        library.loadFolder("folder-a");
        await started;
        library.loadFolder("folder-b");
        await vi.waitFor(() =>
          expect(library.media().map((media) => media.name)).toEqual(["folder-b-video"]),
        );
        olderFolder.resolve(page(["wrong-folder-video"]));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(library.activeFolder()).toBe("folder-b");
        expect(library.media().map((media) => media.name)).toEqual(["folder-b-video"]);
      },
    );
  });

  it("does not append an old cursor page after a library refresh", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/media/refresh")) {
        refreshed = true;
        return Response.json(
          { id: "j_abcdefghijkl", state: "queued", progress: 0, indexed: 0 },
          { status: 202 },
        );
      }
      if (url.includes("/jobs/j_abcdefghijkl/events"))
        return new Response(
          `event: snapshot\nid: cursor-1\ndata: ${JSON.stringify({
            id: "j_abcdefghijkl",
            type: "library_scan",
            state: "succeeded",
            revision: 1,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:01Z",
          })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      throw new Error(`Unexpected generated request: ${String(input)}`);
    };
    const oldCursor = deferredResponse();
    let refreshed = false;
    let cursorRequested!: () => void;
    const started = new Promise<void>((resolve) => {
      cursorRequested = resolve;
    });
    await withLibrary(
      (path) => {
        if (path === "media/tree?cursor=old-page") {
          cursorRequested();
          return oldCursor.promise;
        }
        if (path === "media/refresh") {
          refreshed = true;
          return Promise.resolve(Response.json({}));
        }
        if (path === "media/status")
          return Promise.resolve(Response.json({ state: "ready", message: "Ready" }));
        return Promise.resolve(
          refreshed ? page(["refreshed-video"]) : page(["old-video"], "old-page"),
        );
      },
      async (library) => {
        await vi.waitFor(() => expect(library.nextCursor()).toBe("old-page"));
        library.loadFolder(undefined, "old-page");
        await vi.waitFor(() => expect(library.loadingMore()).toBe(true));
        await started;
        await library.refreshMedia();
        await vi.waitFor(() =>
          expect(library.media().map((media) => media.name)).toEqual(["refreshed-video"]),
        );
        oldCursor.resolve(page(["old-cursor-video"]));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(library.media().map((media) => media.name)).toEqual(["refreshed-video"]);
        expect(library.nextCursor()).toBeUndefined();
      },
      { serverBaseUrl: "http://localhost", authentication: { type: "none" } },
    );
    globalThis.fetch = originalFetch;
  });
});
