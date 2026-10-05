import type * as EffectApiTypes from "../src/generated/effect-api";
import { Effect } from "effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
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
import type { ApiClient, NativeMediaApiClient } from "../src/api";
import { createServerState, type ServerState } from "../src/features/app/server";
import { createLibraryController } from "../src/features/media/controller";

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
    context: { server: ServerState; registry: AtomRegistry.AtomRegistry },
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
  try {
    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        createComponent(RegistryProvider, {
          get children() {
            untrack(() => {
              const registry = useContext(RegistryContext);
              const [status, setStatus] = createSignal("");
              const server = createServerState(api, registry, workspaceConfiguration);
              const library = createLibraryController(server, setStatus);
              queueMicrotask(() => {
                void exercise({ ...library, status }, { server, registry }).then(
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
  } finally {
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
      globalThis.fetch = async () =>
        Response.json(
          { error: { code, message: "Rejected.", requestId: "r-library-rejection" } },
          { status: httpStatus },
        );
      try {
        await withLibrary(
          (path) =>
            path === "media/status"
              ? Promise.resolve(Response.json({ state: "ready_empty", message: "Ready" }))
              : Promise.resolve(page([])),
          async (library) => {
            await library.refreshMedia();
            expect(library.status()).toContain(feedback);
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
});
