import type * as EffectApiTypes from "../src/generated/effect-api";
import { Effect } from "effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { Accessor } from "solid-js";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, NativeMediaApiClient } from "../src/api";
import { createServerState, type ServerState } from "../src/app/server";
import { createLibraryController } from "../src/features/media/controller";
import { createWorkspaceIdentity } from "../src/app/workspaceIdentity";

type LibrarySurface = {
  media: Accessor<EffectApiTypes.Media[]>;
  activeFolder: Accessor<string | undefined>;
  nextCursor: Accessor<string | undefined>;
  loadingMore: () => boolean;
  loadFolder: (folderId?: string, cursor?: string) => void;
  refreshMedia: () => Promise<void>;
  importJob: () => { id: string; state: string; indexed?: number } | undefined;
  scanActive: () => boolean;
  cancellingImport: () => boolean;
  cancelImport: () => Promise<void>;
  status: Accessor<string>;
  observationWaiting: () => boolean;
  libraryError: () => string;
  libraryMessage: () => string;
  scanError: () => string;
  refreshing: () => boolean;
};

const item = (name: string): EffectApiTypes.Media => ({
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
  exercise: (
    library: LibrarySurface,
    context: {
      server: ServerState;
      registry: AtomRegistry.AtomRegistry;
      controller: ReturnType<typeof createLibraryController>;
    },
  ) => Promise<void>,
  configuration?: Parameters<typeof createServerState>[2],
) {
  const api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest"> = {
    url: (path) => path,
    request,
    assetRequest: () => Promise.resolve(Response.json({})),
    mediaRequest: () => Promise.reject(new Error("Unexpected media attachment request")),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.pathname.endsWith("/api/v2/media/tree") ||
      url.pathname.endsWith("/api/v2/media/status")
    ) {
      const path = url.pathname.replace(/^.*\/api\/v2\//, "") + url.search;
      return request(path, init);
    }
    return originalFetch(input, init);
  };
  const workspaceConfiguration = configuration ?? {
    serverBaseUrl: "http://localhost",
    authentication: { type: "none" as const },
  };
  const registry = AtomRegistry.make({ defaultIdleTTL: 0, timeoutResolution: 1 });
  const server = createServerState(api, registry, workspaceConfiguration);
  const identity = createWorkspaceIdentity(server);
  const controller = createLibraryController(server, identity.state);
  const state = () => registry.get(controller.view);
  const awaitCommand = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
    Effect.runPromise(
      AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }).pipe(Effect.ignore),
    );
  try {
    await exercise(
      {
        media: () => state().media,
        activeFolder: () => state().activeFolder,
        nextCursor: () => state().nextCursor,
        loadingMore: () => state().loadingMore,
        loadFolder: controller.loadFolder,
        refreshMedia: () => {
          controller.refreshMedia();
          return awaitCommand(controller.refreshCommand);
        },
        cancelImport: () => {
          controller.cancelImport();
          return awaitCommand(controller.cancelCommand);
        },
        importJob: () => state().importJob,
        scanActive: () => state().scanActive,
        cancellingImport: () => state().cancellingImport,
        observationWaiting: () => state().observationWaiting,
        libraryError: () => state().libraryError,
        libraryMessage: () => state().libraryMessage,
        scanError: () => state().scanError,
        refreshing: () => state().refreshing,
        status: () => registry.get(identity.state).status,
      },
      { server, registry, controller },
    );
  } finally {
    registry.dispose();
    globalThis.fetch = originalFetch;
  }
}

describe("library controller", () => {
  it("retains the key for uncertain scan redelivery and rotates it for a new command", async () => {
    const originalFetch = globalThis.fetch;
    const attempts: Array<{
      path: string;
      key: string;
      body: string | undefined;
    }> = [];
    let submits = 0;
    globalThis.fetch = async (input, init) => {
      attempts.push({
        path: new URL(input instanceof Request ? input.url : String(input)).pathname,
        key: new Headers(init?.headers).get("Idempotency-Key") ?? "",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (submits++ === 0) throw new TypeError("connection lost");
      if (submits === 2)
        return Response.json(
          {
            error: {
              code: "gateway_timeout_unfamiliar",
              message: "Try again.",
              requestId: "r-library-timeout",
            },
          },
          { status: 500 },
        );
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
          expect(attempts).toHaveLength(4);
          expect(attempts[0].path).toBe("/api/v2/media/refresh");
          expect(attempts[0].key).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
          expect(attempts[1]).toEqual(attempts[0]);
          expect(attempts[2]).toEqual(attempts[0]);
          expect(attempts[3].key).not.toBe(attempts[2].key);
          expect(attempts.every(({ body }) => body === undefined)).toBe(true);
        },
        { serverBaseUrl: "http://localhost", authentication: { type: "none" } },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each([
    { code: "origin_forbidden", httpStatus: 403, feedback: "not allowed" },
    { code: "library_busy", httpStatus: 429, feedback: "already in progress" },
  ])(
    "shows actionable generated refresh feedback for $code",
    async ({ code, httpStatus, feedback }) => {
      const originalFetch = globalThis.fetch;
      const keys: string[] = [];
      globalThis.fetch = async (_input, init) => {
        keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        return Response.json(
          { error: { code, message: "Rejected.", requestId: "r-library-rejection" } },
          { status: httpStatus },
        );
      };
      try {
        await withLibrary(
          (path) =>
            path === "media/status"
              ? Promise.resolve(Response.json({ state: "ready_empty", message: "Ready" }))
              : Promise.resolve(page([])),
          async (library) => {
            await library.refreshMedia();
            expect(library.status()).toContain(feedback);
            await library.refreshMedia();
            expect(keys).toHaveLength(2);
            expect(keys[0]).toBeTruthy();
            expect(keys[1]).not.toBe(keys[0]);
          },
          { serverBaseUrl: "http://localhost", authentication: { type: "none" } },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  it("does not infer a rejection status from an unfamiliar generated error code", async () => {
    const originalFetch = globalThis.fetch;
    const attempts: Array<{ key: string; body: string | undefined }> = [];
    let submits = 0;
    globalThis.fetch = async (_input, init) => {
      attempts.push({
        key: new Headers(init?.headers).get("Idempotency-Key") ?? "",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (submits++ === 0)
        return Response.json(
          {
            error: {
              code: "unfamiliar_rate_limit",
              message: "Try again.",
              requestId: "r-unfamiliar-rate-limit",
            },
          },
          { status: 429 },
        );
      return Response.json(
        { id: "j_abcdefghijkl", state: "queued", progress: 0, indexed: 0 },
        { status: 202 },
      );
    };
    try {
      await withLibrary(
        (path) =>
          path === "media/status"
            ? Promise.resolve(Response.json({ state: "ready_empty", message: "Ready" }))
            : Promise.resolve(page([])),
        async (library) => {
          await library.refreshMedia();
          expect(library.status()).toBe("Media refresh failed. Try again.");
          await library.refreshMedia();
          expect(attempts).toHaveLength(2);
          expect(attempts[0].key).toBeTruthy();
          expect(attempts[1]).toEqual(attempts[0]);
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
          expect(library.observationWaiting()).toBe(true);
          expect(library.cancellingImport()).toBe(false);
          pushSnapshot();
          await vi.waitFor(() => expect(library.importJob()?.state).toBe("running"));
          expect(library.importJob()?.indexed).toBe(12);
          expect(library.scanActive()).toBe(true);
          expect(library.cancellingImport()).toBe(false);
          expect(library.observationWaiting()).toBe(false);
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
    const cancellation = deferredResponse();
    let cancellationAborted = false;
    globalThis.fetch = async (_input, init) => {
      if (new Headers(init?.headers).has("Idempotency-Key"))
        return Response.json(
          { id: "j_abcdefghijkl", state: "queued", progress: 0, indexed: 0 },
          { status: 202 },
        );
      init?.signal?.addEventListener("abort", () => {
        cancellationAborted = true;
      });
      return cancellation.promise;
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
          const result = library.cancelImport();
          expect(library.cancellingImport()).toBe(true);
          expect(library.scanActive()).toBe(true);
          library.loadFolder("folder-b");
          expect(library.cancellingImport()).toBe(true);
          expect(cancellationAborted).toBe(false);
          cancellation.resolve(
            Response.json({ error: { code: "internal_error" } }, { status: 500 }),
          );
          await result;
          expect(library.libraryError()).toBe("Scan could not be cancelled. Try again.");
          expect(library.cancellingImport()).toBe(false);
          expect(library.scanActive()).toBe(true);
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
      async (library, { server, registry }) => {
        await vi.waitFor(() =>
          expect(library.media().map((media) => media.name)).toEqual(["root-video"]),
        );
        const staleFolder = server.mediaTree(
          "folder-a",
          undefined,
          registry.get(server.mediaRevision),
        );
        const releaseStaleFolder = registry.mount(staleFolder);
        try {
          library.loadFolder("folder-a");
          await started;
          expect(
            server.mediaTree("folder-b", undefined, registry.get(server.mediaRevision)),
          ).not.toBe(staleFolder);
          library.loadFolder("folder-b");
          await vi.waitFor(() =>
            expect(library.media().map((media) => media.name)).toEqual(["folder-b-video"]),
          );
          olderFolder.resolve(page(["wrong-folder-video"]));
          await Effect.runPromise(
            AtomRegistry.getResult(registry, staleFolder, { suspendOnWaiting: true }),
          );
          expect(library.activeFolder()).toBe("folder-b");
          expect(library.media().map((media) => media.name)).toEqual(["folder-b-video"]);
        } finally {
          olderFolder.resolve(page(["wrong-folder-video"]));
          releaseStaleFolder();
        }
      },
    );
  });

  it("does not append an old cursor page after a library refresh", async () => {
    const originalFetch = globalThis.fetch;
    try {
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
        async (library, { server, registry }) => {
          await vi.waitFor(() => expect(library.nextCursor()).toBe("old-page"));
          const stalePage = server.mediaTree(
            undefined,
            "old-page",
            registry.get(server.mediaRevision),
          );
          const releaseStalePage = registry.mount(stalePage);
          try {
            library.loadFolder(undefined, "old-page");
            await vi.waitFor(() => expect(library.loadingMore()).toBe(true));
            await started;
            await library.refreshMedia();
            const refreshedCursor = server.mediaTree(
              undefined,
              "old-page",
              registry.get(server.mediaRevision),
            );
            expect(refreshedCursor).not.toBe(stalePage);
            await vi.waitFor(() =>
              expect(library.media().map((media) => media.name)).toEqual(["refreshed-video"]),
            );
            oldCursor.resolve(page(["old-cursor-video"]));
            await Effect.runPromise(
              AtomRegistry.getResult(registry, stalePage, { suspendOnWaiting: true }),
            );
            expect(library.media().map((media) => media.name)).toEqual(["refreshed-video"]);
            expect(library.nextCursor()).toBeUndefined();
          } finally {
            oldCursor.resolve(page(["old-cursor-video"]));
            releaseStalePage();
          }
        },
        { serverBaseUrl: "http://localhost", authentication: { type: "none" } },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retains successful pages through retry without duplicate items or cursor requests", async () => {
    const requested: string[] = [];
    const second = deferredResponse();
    let attempts = 0;
    await withLibrary(
      (path) => {
        requested.push(path);
        if (path === "media/status")
          return Promise.resolve(Response.json({ state: "ready_with_media", message: "Ready" }));
        if (path === "media/tree?cursor=second") return second.promise;
        if (path === "media/tree?cursor=third") {
          if (attempts++ === 0) return Promise.resolve(new Response(null, { status: 500 }));
          return Promise.resolve(page(["third-video"]));
        }
        return Promise.resolve(page(["first-video"], "second"));
      },
      async (library, { registry, controller }) => {
        await vi.waitFor(() => expect(library.nextCursor()).toBe("second"));
        library.loadFolder(undefined, "second");
        library.loadFolder(undefined, "second");
        expect(library.loadingMore()).toBe(true);
        expect(library.media().map((item) => item.name)).toEqual(["first-video"]);
        second.resolve(page(["first-video", "second-video"], "third"));
        await Effect.runPromise(
          AtomRegistry.getResult(registry, controller.loadMoreCommand, { suspendOnWaiting: true }),
        );
        expect(library.nextCursor()).toBe("third");
        expect(library.media().map((item) => item.name)).toEqual(["first-video", "second-video"]);
        library.loadFolder(undefined, "second");
        expect(requested.filter((path) => path.endsWith("cursor=second"))).toHaveLength(1);
        library.loadFolder(undefined, "third");
        await Effect.runPromise(
          AtomRegistry.getResult(registry, controller.loadMoreCommand, {
            suspendOnWaiting: true,
          }).pipe(Effect.ignore),
        );
        expect(library.libraryError()).toBe("Media could not be loaded. Try again.");
        expect(library.nextCursor()).toBe("third");
        expect(library.media().map((item) => item.name)).toEqual(["first-video", "second-video"]);
        library.loadFolder(undefined, "third");
        await Effect.runPromise(
          AtomRegistry.getResult(registry, controller.loadMoreCommand, { suspendOnWaiting: true }),
        );
        expect(library.media().map((item) => item.name)).toEqual([
          "first-video",
          "second-video",
          "third-video",
        ]);
        expect(library.nextCursor()).toBeUndefined();
        expect(library.libraryError()).toBe("");
        expect(registry.get(controller.navigation).loadedCursors).toEqual(["second", "third"]);
      },
    );
  });

  it.each([
    ["unconfigured", "Configure the server media root"],
    ["scanning", "Wait for indexing to finish"],
    ["ready_empty", "Mount supported media"],
    ["failed", "Check the server configuration"],
    ["ready_with_media", "Choose a video"],
  ])("preserves the actionable %s library message", async (state, action) => {
    const status = deferredResponse();
    await withLibrary(
      (path) => (path === "media/status" ? status.promise : Promise.resolve(page([]))),
      async (library) => {
        expect(library.libraryMessage()).toBe(
          "Checking the server media library… Refresh to check again.",
        );
        status.resolve(Response.json({ state, message: "Server library message." }));
        await vi.waitFor(() => expect(library.libraryMessage()).toContain(action));
        expect(library.libraryMessage()).toContain("Server library message.");
      },
    );
  });

  it("invalidates accumulated pages once on terminal scan observation and retains workspace state without views", async () => {
    const originalFetch = globalThis.fetch;
    let send!: (state: string, revision: number) => void;
    let streamCancelled = 0;
    let readerReleased = 0;
    let observationAborted = false;
    let treeReads = 0;
    let cancelRequests = 0;
    globalThis.fetch = async (_input, init) => {
      if (init?.method === "DELETE") cancelRequests += 1;
      return Response.json(
        { id: "j_abcdefghijkl", state: "queued", progress: 0, indexed: 0 },
        { status: 202 },
      );
    };
    try {
      await withLibrary(
        (path, init) => {
          if (path === "jobs/j_abcdefghijkl/events") {
            init?.signal?.addEventListener("abort", () => {
              observationAborted = true;
            });
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                send = (state, revision) =>
                  controller.enqueue(
                    new TextEncoder().encode(
                      `event: snapshot\nid: cursor-${revision}\ndata: ${JSON.stringify({
                        id: "j_abcdefghijkl",
                        type: "library_scan",
                        state,
                        revision,
                        progress: 0.5,
                        indexed: revision,
                        createdAt: "2026-01-01T00:00:00Z",
                        updatedAt: "2026-01-01T00:00:01Z",
                      })}\n\n`,
                    ),
                  );
              },
              cancel() {
                streamCancelled += 1;
              },
            });
            const reader = stream.getReader.bind(stream);
            Object.defineProperty(stream, "getReader", {
              value: () => {
                const result = reader();
                const release = result.releaseLock.bind(result);
                result.releaseLock = () => {
                  readerReleased += 1;
                  release();
                };
                return result;
              },
            });
            return Promise.resolve(
              new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
            );
          }
          if (path === "media/status")
            return Promise.resolve(Response.json({ state: "ready_with_media", message: "Ready" }));
          if (path.includes("cursor=second")) return Promise.resolve(page(["second-video"]));
          treeReads += 1;
          return Promise.resolve(page([`root-${treeReads}`], "second"));
        },
        async (library, { registry, controller, server }) => {
          const unsubscribe = registry.subscribe(controller.view, () => undefined, {
            immediate: true,
          });
          await library.refreshMedia();
          expect(library.refreshing()).toBe(false);
          expect(library.observationWaiting()).toBe(true);
          send("running", 1);
          await vi.waitFor(() => expect(library.importJob()?.state).toBe("running"));
          await vi.waitFor(() => expect(library.nextCursor()).toBe("second"));
          library.loadFolder(undefined, "second");
          await Effect.runPromise(
            AtomRegistry.getResult(registry, controller.loadMoreCommand, {
              suspendOnWaiting: true,
            }),
          );
          const retained = registry.get(controller.navigation);
          unsubscribe();
          vi.useFakeTimers();
          try {
            await vi.advanceTimersByTimeAsync(1000);
          } finally {
            vi.useRealTimers();
          }
          expect(registry.get(controller.navigation)).toBe(retained);
          expect(library.media().some((item) => item.name === "second-video")).toBe(true);
          expect(library.scanActive()).toBe(true);
          expect(streamCancelled).toBe(0);
          const beforeCompletion = registry.get(server.mediaRevision);
          send("succeeded", 2);
          await vi.waitFor(() => expect(library.importJob()?.state).toBe("succeeded"));
          expect(registry.get(server.mediaRevision)).toBe(beforeCompletion + 1);
          expect(registry.get(controller.navigation).loadedCursors).toEqual([]);
          expect(library.scanActive()).toBe(false);
          const resubscribe = registry.subscribe(controller.view, () => undefined, {
            immediate: true,
          });
          resubscribe();
          expect(registry.get(server.mediaRevision)).toBe(beforeCompletion + 1);
          expect(cancelRequests).toBe(0);
          registry.dispose();
          expect(streamCancelled).toBe(1);
          expect(readerReleased).toBe(1);
          expect(observationAborted).toBe(true);
          expect(cancelRequests).toBe(0);
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("workspace disposal interrupts pending refresh without cancelling a durable scan or publishing late identity", async () => {
    const originalFetch = globalThis.fetch;
    const response = deferredResponse();
    let aborted = false;
    let started = false;
    let cancels = 0;
    globalThis.fetch = (_input, init) => {
      if (init?.method === "DELETE") cancels += 1;
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      started = true;
      return response.promise;
    };
    try {
      await withLibrary(
        (path) =>
          Promise.resolve(
            path === "media/status"
              ? Response.json({ state: "ready_empty", message: "Ready" })
              : page([]),
          ),
        async (library, { registry, controller }) => {
          controller.refreshMedia();
          controller.refreshMedia();
          await vi.waitFor(() => expect(started).toBe(true));
          expect(library.refreshing()).toBe(true);
          expect(library.scanActive()).toBe(false);
          expect(library.observationWaiting()).toBe(false);
          expect(library.cancellingImport()).toBe(false);
          const published: Array<string | undefined> = [];
          registry.subscribe(controller.scanIdentity, (scan) => published.push(scan.id));
          registry.dispose();
          expect(aborted).toBe(true);
          response.resolve(
            Response.json(
              { id: "j_abcdefghijkl", state: "queued", progress: 0, indexed: 0 },
              { status: 202 },
            ),
          );
          for (let index = 0; index < 10; index++) await Promise.resolve();
          expect(published).toEqual([]);
          expect(cancels).toBe(0);
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("folder navigation discards an obsolete cursor page and command error", async () => {
    const cursor = deferredResponse();
    let requested = false;
    await withLibrary(
      (path) => {
        if (path === "media/status")
          return Promise.resolve(Response.json({ state: "ready_with_media", message: "Ready" }));
        if (path === "media/tree?cursor=second") {
          requested = true;
          return cursor.promise;
        }
        if (path === "media/tree?folderId=folder-b")
          return Promise.resolve(page(["folder-b-video"]));
        return Promise.resolve(page(["root-video"], "second"));
      },
      async (library, { registry, server, controller }) => {
        await vi.waitFor(() => expect(library.nextCursor()).toBe("second"));
        const oldPage = server.mediaTree(undefined, "second", registry.get(server.mediaRevision));
        const release = registry.mount(oldPage);
        try {
          library.loadFolder(undefined, "second");
          await vi.waitFor(() => expect(requested).toBe(true));
          library.loadFolder("folder-b");
          expect(library.loadingMore()).toBe(false);
          expect(registry.get(controller.navigation).pendingCursor).toBeUndefined();
          expect(registry.get(controller.navigation).loadedCursors).toEqual([]);
          await vi.waitFor(() =>
            expect(library.media().map((item) => item.name)).toEqual(["folder-b-video"]),
          );
          cursor.resolve(page(["wrong-video"]));
          await Effect.runPromise(
            AtomRegistry.getResult(registry, oldPage, { suspendOnWaiting: true }),
          );
          expect(library.media().map((item) => item.name)).toEqual(["folder-b-video"]);
          expect(library.libraryError()).toBe("");
        } finally {
          cursor.resolve(page([]));
          release();
        }
      },
    );
  });

  it("releases an active workspace observation on disposal without sending a cancel command", async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = 0;
    let aborted = false;
    let cancelRequests = 0;
    globalThis.fetch = async (_input, init) => {
      if (init?.method === "DELETE") cancelRequests += 1;
      return Response.json(
        { id: "j_abcdefghijkl", state: "queued", progress: 0, indexed: 0 },
        { status: 202 },
      );
    };
    try {
      await withLibrary(
        (path, init) => {
          if (path === "jobs/j_abcdefghijkl/events") {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
            });
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `event: snapshot\nid: cursor-1\ndata: ${JSON.stringify({
                      id: "j_abcdefghijkl",
                      type: "library_scan",
                      state: "running",
                      revision: 1,
                      createdAt: "2026-01-01T00:00:00Z",
                      updatedAt: "2026-01-01T00:00:01Z",
                    })}\n\n`,
                  ),
                );
              },
              cancel() {
                cancelled += 1;
              },
            });
            return Promise.resolve(
              new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
            );
          }
          return Promise.resolve(
            path === "media/status"
              ? Response.json({ state: "ready_empty", message: "Ready" })
              : page([]),
          );
        },
        async (library, { registry, controller }) => {
          const closeView = registry.subscribe(controller.view, () => undefined, {
            immediate: true,
          });
          await library.refreshMedia();
          await vi.waitFor(() => expect(library.importJob()?.state).toBe("running"));
          closeView();
          expect(aborted).toBe(false);
          expect(cancelled).toBe(0);
          expect(cancelRequests).toBe(0);
          registry.dispose();
          await vi.waitFor(() => expect(aborted).toBe(true));
          expect(cancelled).toBe(1);
          expect(cancelRequests).toBe(0);
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
