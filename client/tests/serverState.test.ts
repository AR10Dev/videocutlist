import { Effect } from "effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { RegistryContext, RegistryProvider } from "@effect/atom-solid";
import { createComponent, createRoot, untrack, useContext } from "solid-js";
import { describe, expect, it, vi } from "@effect/vitest";
import { authenticationRequiredEvent, createApiClient } from "../src/api";
import { createWorkspaceController } from "../src/features/app/controller";
import { createServerState } from "../src/features/app/server";
import type { Batch, Job } from "../src/generated/effect-api";

describe("workspace server atoms", () => {
  it("disposing a workspace aborts its in-flight server reads", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let aborted = false;
    const configuration = {
      serverBaseUrl: "https://example.test",
      authentication: { type: "none" as const },
    };
    vi.stubGlobal(
      "fetch",
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("Request cancelled.", "AbortError"));
            },
            { once: true },
          );
          requestStarted();
        }),
    );
    const api = createApiClient(configuration);
    const registry = AtomRegistry.make();
    const server = createServerState(api, registry, configuration);
    registry.mount(server.media(`m_${"a".repeat(43)}`));
    await started;
    registry.dispose();
    expect(aborted).toBe(true);
    vi.unstubAllGlobals();
  });

  it("owns canonical generated library reads and replaces their identities on refresh", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer library-token");
      const url = String(input);
      if (url.endsWith("/media/tree"))
        return Response.json({ folders: [], items: [], nextCursor: null });
      if (url.endsWith("/media/status"))
        return Response.json({ state: "ready_empty", message: "No media" });
      throw new Error(`Unexpected generated request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const configuration = {
      serverBaseUrl: "https://example.test/deployment",
      authentication: { type: "bearer" as const, token: "library-token" },
    };
    const registry = AtomRegistry.make();
    const server = createServerState(createApiClient(configuration), registry, configuration);
    const revision = registry.get(server.mediaRevision);
    const first = server.mediaTree(undefined, undefined, revision);
    expect(server.mediaTree(undefined, undefined, revision)).toBe(first);
    expect(server.mediaTree("folder-a", "cursor-a", revision)).toBe(
      server.mediaTree("folder-a", "cursor-a", revision),
    );
    expect(server.mediaTree("folder-a", "cursor-a", revision)).not.toBe(
      server.mediaTree("folder-a", "cursor-b", revision),
    );
    const mediaId = `m_${"a".repeat(43)}`;
    const firstMetadata = server.media(mediaId, revision);
    expect(server.media(mediaId, revision)).toBe(firstMetadata);
    registry.mount(first);
    await expect(
      Effect.runPromise(AtomRegistry.getResult(registry, first, { suspendOnWaiting: true })),
    ).resolves.toMatchObject({ items: [] });
    const status = server.mediaLibraryStatus(revision);
    registry.mount(status);
    await expect(
      Effect.runPromise(AtomRegistry.getResult(registry, status, { suspendOnWaiting: true })),
    ).resolves.toMatchObject({ state: "ready_empty" });
    expect(fetch).toHaveBeenCalledTimes(2);

    server.refreshMedia();
    const refreshedRevision = registry.get(server.mediaRevision);
    const refreshed = server.mediaTree(undefined, undefined, refreshedRevision);
    expect(refreshed).not.toBe(first);
    expect(server.media(mediaId, refreshedRevision)).not.toBe(firstMetadata);
    expect(server.mediaLibraryStatus(refreshedRevision)).not.toBe(status);
    registry.dispose();
    vi.unstubAllGlobals();
  });

  it("resolves a generated API atom through the workspace registry with shared auth policy", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer workspace-token");
      return Response.json({ items: [], nextCursor: null });
    });
    vi.stubGlobal("fetch", fetch);
    const configuration = {
      serverBaseUrl: "https://example.test/deployment",
      authentication: { type: "bearer" as const, token: "workspace-token" },
    };
    const registry = AtomRegistry.make();
    const server = createServerState(createApiClient(configuration), registry, configuration);
    const atom = server.generatedApi!.query("default", "listMedia", { query: {} });
    registry.mount(atom);
    const started = await Effect.runPromise(
      AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }),
    );
    expect(started.items).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
    registry.dispose();
    vi.unstubAllGlobals();
  });

  it("isolates generated requests and auth events across actual workspace replacement", async () => {
    let oldRequestsStarted = 0;
    let resolveOldStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => {
      resolveOldStarted = resolve;
    });
    const oldResponses: { url: string; resolve: (response: Response) => void }[] = [];
    let oldAbortedRequests = 0;
    let authRequiredEvents = 0;
    let newRequestUsedNewAuth = false;
    const fetch: typeof globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const authorization = new Headers(init?.headers).get("Authorization");
        if (
          authorization === "Bearer old-token" &&
          (url.includes("/api/v2/media") || url.includes("/api/v2/settings"))
        ) {
          init?.signal?.addEventListener("abort", () => oldAbortedRequests++, { once: true });
          oldRequestsStarted++;
          if (oldRequestsStarted === 2) resolveOldStarted();
          return new Promise<Response>((resolve) => oldResponses.push({ url, resolve }));
        }
        if (url.includes("/api/v2/media") && authorization === "Bearer new-token") {
          newRequestUsedNewAuth = true;
          return Response.json({ items: [], nextCursor: null });
        }
        return Response.json({});
      },
    );
    vi.stubGlobal("fetch", fetch);
    const browser = Object.assign(new EventTarget(), {
      location: { origin: "https://example.test" },
      confirm: () => true,
    }) as Window;
    vi.stubGlobal("window", browser);
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    } satisfies Partial<Storage>);
    const mountWorkspace = (token: string) => {
      browser.VIDEOCUTLIST_CONFIG = {
        serverBaseUrl: "https://example.test",
        authentication: { type: "bearer", token },
      };
      let dispose!: () => void;
      let registry!: AtomRegistry.AtomRegistry;
      let getResult!: () => Promise<unknown>;
      createRoot((disposeRoot: () => void) => {
        dispose = disposeRoot;
        createComponent(RegistryProvider, {
          get children() {
            untrack(() => {
              registry = useContext(RegistryContext);
              createWorkspaceController();
              const configuration = browser.VIDEOCUTLIST_CONFIG!;
              const server = createServerState(
                createApiClient(configuration),
                registry,
                configuration,
              );
              const atom = server.generatedApi!.query("default", "listMedia", { query: {} });
              const settingsAtom = server.generatedApi!.query("default", "getSettings", {});
              registry.mount(atom);
              if (token === "old-token") registry.mount(settingsAtom);
              getResult = () =>
                Effect.runPromise(
                  AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }),
                );
            });
            return null;
          },
        });
      });
      return { dispose, registry, getResult };
    };
    const onAuthRequired = () => authRequiredEvents++;
    window.addEventListener(authenticationRequiredEvent, onAuthRequired);
    try {
      const oldWorkspace = mountWorkspace("old-token");
      await oldStarted;
      oldWorkspace.dispose();
      expect(oldRequestsStarted).toBeGreaterThanOrEqual(2);
      expect(oldAbortedRequests).toBe(oldRequestsStarted);

      const replacement = mountWorkspace("new-token");
      const newResult = await replacement.getResult();
      expect(newResult).toMatchObject({ items: [] });
      expect(newRequestUsedNewAuth).toBe(true);

      for (const { url, resolve } of oldResponses) {
        resolve(
          url.includes("/api/v2/media")
            ? Response.json({ items: [{ id: "stale" }], nextCursor: null })
            : Response.json(
                { error: { code: "unauthorized", message: "Unauthorized", requestId: "" } },
                { status: 401 },
              ),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(authRequiredEvents).toBe(0);
      expect(await replacement.getResult()).toEqual(newResult);
      replacement.dispose();
    } finally {
      browser.removeEventListener(authenticationRequiredEvent, onAuthRequired);
      vi.unstubAllGlobals();
      delete browser.VIDEOCUTLIST_CONFIG;
    }
  });

  it("retries generated metadata after interruptible 1, 2, and 4 second delays", async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const metadata = {
      id: `m_${"a".repeat(43)}`,
      name: "clip.mp4",
      durationMs: 1000,
      sizeBytes: 10,
      container: "mp4",
      streams: {},
      etag: "v1",
    };
    vi.stubGlobal("fetch", async () => {
      attempts.push(Date.now());
      if (attempts.length < 4)
        return Response.json(
          { error: { code: "internal_error", message: "Try again", requestId: "r-test" } },
          { status: 503 },
        );
      return Response.json(metadata);
    });
    const configuration = {
      serverBaseUrl: "https://example.test",
      authentication: { type: "none" as const },
    };
    const registry = AtomRegistry.make();
    const server = createServerState(createApiClient(configuration), registry, configuration);
    const atom = server.media(metadata.id);
    registry.mount(atom);
    const result = Effect.runPromise(
      AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }),
    );
    const flush = async () => {
      for (let index = 0; index < 12; index++) await Promise.resolve();
    };
    try {
      await flush();
      expect(attempts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999);
      await flush();
      expect(attempts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(attempts).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1999);
      await flush();
      expect(attempts).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(attempts).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(3999);
      await flush();
      expect(attempts).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ id: metadata.id });
      expect(attempts).toHaveLength(4);
      expect(attempts[1] - attempts[0]).toBe(1000);
      expect(attempts[2] - attempts[1]).toBe(2000);
      expect(attempts[3] - attempts[2]).toBe(4000);
    } finally {
      registry.dispose();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("owns one terminal job snapshot atom per identity", async () => {
    const job: Job = {
      id: "j_one",
      type: "export",
      state: "succeeded",
      revision: 2,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:01Z",
    };
    const batch = { batchId: "b_one", state: "succeeded", progress: 1, jobs: [] };
    const fetch = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          String(input).includes("/batches/")
            ? `event: snapshot\nid: cursor-2\ndata: ${JSON.stringify(batch)}\n\n` +
                `event: snapshot\nid: cursor-3\ndata: ${JSON.stringify({ ...batch, state: "running", progress: 0.5 })}\n\n`
            : `event: snapshot\nid: cursor-1\ndata: ${JSON.stringify({ ...job, id: "j_other", state: "running" })}\n\n` +
                `event: snapshot\nid: cursor-2\ndata: ${JSON.stringify(job)}\n\n` +
                `event: snapshot\nid: cursor-3\ndata: ${JSON.stringify({ ...job, state: "running", revision: 3 })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const configuration = {
      serverBaseUrl: "https://example.test",
      authentication: { type: "none" as const },
    };
    const registry = AtomRegistry.make();
    const server = createServerState(createApiClient(configuration), registry, configuration);
    const atom = server.observeJob("j_one");
    expect(server.observeJob("j_one")).toBe(atom);
    const result = await Effect.runPromise(
      AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }),
    );
    expect(result).toMatchObject({ id: "j_one", revision: 2, state: "succeeded" });
    expect(fetch).toHaveBeenCalledOnce();
    const batchAtom = server.observeBatch("b_one");
    expect(server.observeBatch("b_one")).toBe(batchAtom);
    await expect(
      Effect.runPromise(AtomRegistry.getResult(registry, batchAtom, { suspendOnWaiting: true })),
    ).resolves.toMatchObject({ batchId: "b_one", state: "succeeded" });
    expect(fetch).toHaveBeenCalledTimes(2);
    registry.dispose();
    vi.unstubAllGlobals();
  });

  it("keeps terminal job seeds stable without opening an unnecessary stream", async () => {
    const terminal: Job = {
      id: "j_seed_terminal",
      type: "export",
      state: "succeeded",
      revision: 2,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:01Z",
    };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const configuration = {
      serverBaseUrl: "https://example.test",
      authentication: { type: "none" as const },
    };
    const registry = AtomRegistry.make();
    const server = createServerState(createApiClient(configuration), registry, configuration);
    const atom = server.observeJob(terminal.id, terminal);
    expect(server.observeJob(terminal.id)).toBe(atom);
    await expect(
      Effect.runPromise(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true })),
    ).resolves.toEqual(terminal);
    expect(fetch).not.toHaveBeenCalled();
    registry.dispose();
    vi.unstubAllGlobals();
  });

  it("keeps local job cancellation above stale stream snapshots and disposes without DELETE", async () => {
    let sendProgress!: () => void;
    let sendStale!: () => void;
    let sendAfterClear!: () => void;
    let sendTerminal!: () => void;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => (requestStarted = resolve));
    let aborted = false;
    const job = (revision: number): Job => ({
      id: "j_local",
      type: "export",
      state: "running",
      revision,
      progress: revision / 10,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:0" + revision + "Z",
    });
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).get("Authorization") === "Bearer new")
        return new Response(
          `event: snapshot\nid: cursor-new\ndata: ${JSON.stringify({ ...job(4), state: "succeeded" })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(`event: snapshot\nid: cursor-1\ndata: ${JSON.stringify(job(2))}\n\n`),
          );
          sendProgress = () =>
            controller.enqueue(
              encoder.encode(`event: snapshot\nid: cursor-2\ndata: ${JSON.stringify(job(3))}\n\n`),
            );
          sendStale = () =>
            controller.enqueue(
              encoder.encode(`event: snapshot\nid: cursor-3\ndata: ${JSON.stringify(job(4))}\n\n`),
            );
          sendAfterClear = () =>
            controller.enqueue(
              encoder.encode(`event: snapshot\nid: cursor-4\ndata: ${JSON.stringify(job(4))}\n\n`),
            );
          sendTerminal = () => {
            controller.enqueue(
              encoder.encode(
                `event: snapshot\nid: cursor-5\ndata: ${JSON.stringify({ ...job(6), id: "j_other", state: "succeeded" })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `event: snapshot\nid: cursor-6\ndata: ${JSON.stringify({ ...job(5), state: "succeeded" })}\n\n`,
              ),
            );
          };
          requestStarted();
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              controller.error(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetch);
    const configuration = {
      serverBaseUrl: "https://example.test",
      authentication: { type: "bearer" as const, token: "old" },
    };
    const registry = AtomRegistry.make();
    const server = createServerState(createApiClient(configuration), registry, configuration);
    const atom = server.observeJob("j_local", job(2));
    await started;
    await vi.waitFor(() =>
      expect(registry.get(atom)).toMatchObject({ value: { state: "running", revision: 2 } }),
    );
    sendProgress();
    await vi.waitFor(() =>
      expect(registry.get(atom)).toMatchObject({ value: { state: "running", revision: 3 } }),
    );
    server.setJobLocallyCancelled("j_local", true);
    sendStale();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.get(atom)).toMatchObject({
      value: { state: "running", revision: 3, progress: 0.3 },
    });
    server.setJobLocallyCancelled("j_local", false);
    sendAfterClear();
    await vi.waitFor(() =>
      expect(registry.get(atom)).toMatchObject({ value: { state: "running", revision: 4 } }),
    );
    server.setJobLocallyCancelled("j_local", true);
    sendTerminal();
    await vi.waitFor(() =>
      expect(registry.get(atom)).toMatchObject({
        value: { id: "j_local", state: "succeeded", revision: 5 },
      }),
    );
    server.setJobLocallyCancelled("j_local", false);
    expect(server.observeJob("j_local", job(2))).toBe(atom);
    expect(fetch).toHaveBeenCalledOnce();
    registry.dispose();
    expect(aborted).toBe(true);
    const replacementConfiguration = {
      serverBaseUrl: "https://example.test",
      authentication: { type: "bearer" as const, token: "new" },
    };
    const replacementRegistry = AtomRegistry.make();
    const replacement = createServerState(
      createApiClient(replacementConfiguration),
      replacementRegistry,
      replacementConfiguration,
    );
    const replacementAtom = replacement.observeJob("j_local");
    await expect(
      Effect.runPromise(
        AtomRegistry.getResult(replacementRegistry, replacementAtom, { suspendOnWaiting: true }),
      ),
    ).resolves.toMatchObject({ state: "succeeded", revision: 4 });
    replacementRegistry.dispose();
    expect(
      fetch.mock.calls.some(
        ([input, init]) => String(input).includes("DELETE") || init?.method === "DELETE",
      ),
    ).toBe(false);
    vi.unstubAllGlobals();
  });

  it("accepts a valid terminal batch snapshot while local cancellation is pending", async () => {
    let sendSnapshots!: () => void;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => (requestStarted = resolve));
    const batch = (batchId: string, state: Batch["state"], revision: number): Batch => ({
      batchId,
      state,
      progress: state === "succeeded" ? 1 : 0.2,
      jobs: [
        {
          id: "j_batch",
          type: "export",
          state,
          revision,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:01Z",
        },
      ],
    });
    const fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          sendSnapshots = () => {
            controller.enqueue(
              encoder.encode(
                `event: snapshot\nid: cursor-1\ndata: ${JSON.stringify(batch("b_other", "succeeded", 4))}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `event: snapshot\nid: cursor-2\ndata: ${JSON.stringify(batch("b_batch", "succeeded", 3))}\n\n`,
              ),
            );
          };
          requestStarted();
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetch);
    const configuration = {
      serverBaseUrl: "https://example.test",
      authentication: { type: "none" as const },
    };
    const registry = AtomRegistry.make();
    const server = createServerState(createApiClient(configuration), registry, configuration);
    const atom = server.observeBatch("b_batch", batch("b_batch", "running", 2));
    server.setBatchLocallyCancelled("b_batch", true);
    await started;
    sendSnapshots();
    await vi.waitFor(() =>
      expect(registry.get(atom)).toMatchObject({
        value: { batchId: "b_batch", state: "succeeded", jobs: [{ revision: 3 }] },
      }),
    );
    server.setBatchLocallyCancelled("b_batch", false);
    expect(server.observeBatch("b_batch")).toBe(atom);
    expect(fetch).toHaveBeenCalledOnce();
    registry.dispose();
    vi.unstubAllGlobals();
  });

  it("propagates terminal observation authorization errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "forbidden", message: "Forbidden", requestId: "request" } },
          { status: 403 },
        ),
      ),
    );
    const configuration = {
      serverBaseUrl: "https://example.test",
      authentication: { type: "none" as const },
    };
    const registry = AtomRegistry.make();
    const server = createServerState(createApiClient(configuration), registry, configuration);
    const atom = server.observeJob("j_forbidden");
    await expect(
      Effect.runPromise(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true })),
    ).rejects.toThrow("Forbidden");
    registry.dispose();
    vi.unstubAllGlobals();
  });

  it("interrupts an in-flight generated atom when its workspace registry is disposed", async () => {
    let requestStarted!: () => void;
    let requestAborted = false;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              requestAborted = true;
              reject(new DOMException("Request cancelled.", "AbortError"));
            },
            { once: true },
          );
          requestStarted();
        }),
    );
    const configuration = {
      serverBaseUrl: "https://example.test",
      authentication: { type: "none" as const },
    };
    const registry = AtomRegistry.make();
    const server = createServerState(createApiClient(configuration), registry, configuration);
    const atom = server.generatedApi!.query("default", "listMedia", { query: {} });
    registry.mount(atom);
    await started;
    registry.dispose();
    expect(requestAborted).toBe(true);
    vi.unstubAllGlobals();
  });
});
