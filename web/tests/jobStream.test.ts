import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it, vi } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { ApiFailure, createApiClient } from "../src/api";
import { Job } from "../src/generated/effect-api";
import type { Job as JobSnapshot } from "../src/generated/effect-api";
import { observeSnapshots } from "../src/features/queue/jobStream";

describe("job snapshot stream", () => {
  it("decodes split UTF-8 frames and reconnects with its cursor without duplicate snapshots", async () => {
    const encoder = new TextEncoder();
    const snapshot = (revision: number, state: "running" | "succeeded") =>
      JSON.stringify({
        id: "j_demo",
        type: "export",
        state,
        revision,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:01Z",
        mediaLabel: "café 🎞️",
      });
    const eventData = encoder.encode(snapshot(1, "running"));
    const splitAt = eventData.findIndex((byte) => byte >= 0xf0);
    const chunks = [
      encoder.encode(
        ": keepalive\r\nretry: 1\r\n\r\nevent: ignored\nid: ignored-cursor\ndata: {}\n\nevent: snapshot\r\nid: cursor-1\ndata: {broken}\n\nevent: snapshot\nid: bad-schema\ndata: " +
          JSON.stringify({ state: "unknown" }) +
          "\n\n",
      ),
      encoder.encode("event: snapshot\r\nid: cursor-1\r\ndata: "),
      eventData.slice(0, splitAt + 2),
      eventData.slice(splitAt + 2),
      encoder.encode("\r"),
      encoder.encode("\n\r"),
      encoder.encode("\n"),
    ];
    const reader = (parts: Uint8Array[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      });
    let requests = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      requests += 1;
      if (requests === 1)
        return Promise.resolve(
          new Response(reader(chunks), { headers: { "Content-Type": "text/event-stream" } }),
        );
      expect(new Headers(init?.headers).get("Last-Event-ID")).toBe("cursor-1");
      return Promise.resolve(
        new Response(
          reader([
            encoder.encode(`event: snapshot\nid: cursor-1\ndata: ${snapshot(1, "running")}\n\n`),
            encoder.encode(`event: resync\nid: cursor-2\ndata: ${snapshot(2, "succeeded")}\n\n`),
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    });
    const api = createApiClient(
      {
        serverBaseUrl: "https://video.example.test/videocutlist",
        authentication: { type: "bearer", token: "private" },
      },
      fetch,
    );

    const snapshots = await Effect.runPromise(
      Stream.runCollect(
        observeSnapshots<JobSnapshot, JobSnapshot>(
          api,
          "jobs/j_demo/events",
          Job,
          (job) => job.state === "succeeded",
        ),
      ),
    );

    expect([...snapshots].map((job) => [job.revision, job.state])).toEqual([
      [1, "running"],
      [2, "succeeded"],
    ]);
    expect(requests).toBe(2);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("authorization")).toBe(
      "Bearer private",
    );
    expect(String(fetch.mock.calls[0][0])).toBe(
      "https://video.example.test/videocutlist/api/v2/jobs/j_demo/events",
    );
  });

  it("dispatches a valid terminal snapshot when the response ends without a final newline", async () => {
    const encoder = new TextEncoder();
    const event = `event: snapshot\nid: eof-cursor\ndata: ${JSON.stringify({
      id: "j_demo",
      type: "export",
      state: "succeeded",
      revision: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
    })}`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(event));
        controller.close();
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" } })),
    );
    const api = createApiClient(
      { serverBaseUrl: "https://video.example.test", authentication: { type: "none" } },
      fetch,
    );

    const snapshots = await Effect.runPromise(
      Stream.runCollect(observeSnapshots<JobSnapshot, JobSnapshot>(api, "jobs/j_demo/events", Job)),
    );

    expect([...snapshots]).toHaveLength(1);
    expect([...snapshots][0]).toMatchObject({ revision: 1, state: "succeeded" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("dispatches a valid snapshot larger than Effect's default event limit across chunks", async () => {
    const encoder = new TextEncoder();
    const mediaLabel = "x".repeat(10 * 1024 * 1024 + 1024);
    const payload = JSON.stringify({
      id: "j_demo",
      type: "export",
      state: "succeeded",
      revision: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
      mediaLabel,
    });
    const splitAt = 10 * 1024 * 1024 + 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`event: snapshot\nid: large-cursor\ndata: ${payload.slice(0, splitAt)}`),
        );
        controller.enqueue(encoder.encode(`${payload.slice(splitAt)}\n\n`));
        controller.close();
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" } })),
    );
    const api = createApiClient(
      { serverBaseUrl: "https://video.example.test", authentication: { type: "none" } },
      fetch,
    );

    const snapshots = await Effect.runPromise(
      Stream.runCollect(observeSnapshots<JobSnapshot, JobSnapshot>(api, "jobs/j_demo/events", Job)),
    );

    expect([...snapshots]).toHaveLength(1);
    expect([...snapshots][0]).toMatchObject({ state: "succeeded", mediaLabel });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("backs off after transient fetch failure, reconnects with auth and cursor, then emits the next snapshot", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const encoder = new TextEncoder();
    const job = (revision: number, state: "running" | "succeeded") =>
      JSON.stringify({
        id: "j_demo",
        type: "export",
        state,
        revision,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:01Z",
      });
    const response = (event: string, id: string, data: string) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: ${event}\nid: ${id}\ndata: ${data}\n\n`));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    let resolveThird!: () => void;
    let resolveTerminal!: () => void;
    const firstSnapshot = new Promise<void>((resolve) => (resolveFirst = resolve));
    const secondRequest = new Promise<void>((resolve) => (resolveSecond = resolve));
    const thirdRequest = new Promise<void>((resolve) => (resolveThird = resolve));
    const terminalSnapshot = new Promise<void>((resolve) => (resolveTerminal = resolve));
    let requests = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      const requestNumber = requests++;
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private");
      if (requestNumber === 0)
        return Promise.resolve(response("snapshot", "cursor-1", job(1, "running")));
      expect(new Headers(init?.headers).get("Last-Event-ID")).toBe("cursor-1");
      if (requestNumber === 1) {
        resolveSecond();
        return Promise.reject(new TypeError("temporary network failure"));
      }
      resolveThird();
      return Promise.resolve(response("snapshot", "cursor-2", job(2, "succeeded")));
    });
    const api = createApiClient(
      {
        serverBaseUrl: "https://video.example.test",
        authentication: { type: "bearer", token: "private" },
      },
      fetch,
    );
    const snapshots: JobSnapshot[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(
        observeSnapshots<JobSnapshot, JobSnapshot>(api, "jobs/j_demo/events", Job),
        (snapshot) =>
          Effect.sync(() => {
            snapshots.push(snapshot);
            if (snapshot.revision === 1) resolveFirst();
            if (snapshot.revision === 2) resolveTerminal();
          }),
      ),
    );

    try {
      await firstSnapshot;
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(249);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await secondRequest;
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await thirdRequest;
      await terminalSnapshot;
      await Effect.runPromise(Fiber.interrupt(fiber));

      expect(snapshots.map(({ revision, state }) => [revision, state])).toEqual([
        [1, "running"],
        [2, "succeeded"],
      ]);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(String(fetch.mock.calls[0][0])).not.toContain("private");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      vi.useRealTimers();
    }
  });

  it("interrupts reconnect backoff and leaves no active reader or retry timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const encoder = new TextEncoder();
    let readerBody: ReadableStream<Uint8Array> | undefined;
    let requestSignal: AbortSignal | undefined;
    let snapshotSeen!: () => void;
    const seen = new Promise<void>((resolve) => (snapshotSeen = resolve));
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      readerBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: snapshot\nid: cursor-1\ndata: ${JSON.stringify({
                id: "j_demo",
                type: "export",
                state: "running",
                revision: 1,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:01Z",
              })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(readerBody, { headers: { "Content-Type": "text/event-stream" } }),
      );
    });
    const api = createApiClient(
      { serverBaseUrl: "https://video.example.test", authentication: { type: "none" } },
      fetch,
    );
    const fiber = Effect.runFork(
      Stream.runForEach(
        observeSnapshots<JobSnapshot, JobSnapshot>(api, "jobs/j_demo/events", Job),
        () => Effect.sync(snapshotSeen),
      ),
    );

    try {
      await seen;
      await vi.advanceTimersByTimeAsync(0);
      for (let turn = 0; turn < 10 && vi.getTimerCount() === 0; turn++) await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);
      expect(readerBody?.locked).toBe(false);
      await Effect.runPromise(Fiber.interrupt(fiber));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(requestSignal?.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      vi.useRealTimers();
    }
  });

  it("backpressures slow consumers and delivers a queued terminal snapshot exactly once", async () => {
    const encoder = new TextEncoder();
    const payload = (revision: number, state: "running" | "succeeded") =>
      JSON.stringify({
        id: "j_demo",
        type: "export",
        state,
        revision,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:01Z",
      });
    const frames = Array.from({ length: 9 }, (_, index) => {
      const revision = index + 1;
      const state = revision === 9 ? "succeeded" : "running";
      return `event: snapshot\nid: cursor-${revision}\ndata: ${payload(revision, state)}\n\n`;
    });
    let pulls = 0;
    let resolveThirdPull!: () => void;
    let resolveFirst!: () => void;
    let resolveTerminal!: () => void;
    let releaseFirst!: () => void;
    const thirdPull = new Promise<void>((resolve) => (resolveThirdPull = resolve));
    const firstSeen = new Promise<void>((resolve) => (resolveFirst = resolve));
    const terminalSeen = new Promise<void>((resolve) => (resolveTerminal = resolve));
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const index = pulls++;
          if (index === 2) resolveThirdPull();
          if (index < frames.length) controller.enqueue(encoder.encode(frames[index]));
          else controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const api = createApiClient(
      { serverBaseUrl: "https://video.example.test", authentication: { type: "none" } },
      () =>
        Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" } })),
    );
    const revisions: number[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(
        observeSnapshots<JobSnapshot, JobSnapshot>(api, "jobs/j_demo/events", Job),
        (snapshot) =>
          Effect.tryPromise({
            try: async () => {
              revisions.push(snapshot.revision);
              if (snapshot.revision === 1) {
                resolveFirst();
                await firstGate;
              }
              if (snapshot.state === "succeeded") resolveTerminal();
            },
            catch: (cause) => (cause instanceof Error ? cause : new Error("consumer failed")),
          }),
      ),
    );

    try {
      await firstSeen;
      await thirdPull;
      await Effect.runPromise(Effect.yieldNow);
      expect(pulls).toBe(3);
      expect(revisions).toEqual([1]);

      releaseFirst();
      await terminalSeen;
      await Effect.runPromise(Fiber.await(fiber));
      expect(revisions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(revisions.filter((revision) => revision === 9)).toHaveLength(1);
      expect(pulls).toBe(9);
      expect(body.locked).toBe(false);
    } finally {
      releaseFirst();
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  it("bounds snapshot decoding when many frames arrive in one native chunk", async () => {
    const frames = Array.from({ length: 9 }, (_, index) => {
      const revision = index + 1;
      return `event: snapshot\nid: cursor-${revision}\ndata: ${JSON.stringify({
        id: "j_demo",
        type: "export",
        state: revision === 9 ? "succeeded" : "running",
        revision,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:01Z",
      })}\n\n`;
    }).join("");
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode(frames));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const api = createApiClient(
      { serverBaseUrl: "https://video.example.test", authentication: { type: "none" } },
      () => Promise.resolve(new Response(body)),
    );
    const isTerminal = vi.fn((snapshot: JobSnapshot) => snapshot.state === "succeeded");
    let releaseFirst!: () => void;
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const firstSeen = new Promise<void>((resolve) => (resolveFirst = resolve));
    const revisions: number[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(
        observeSnapshots<JobSnapshot, JobSnapshot>(api, "jobs/j_demo/events", Job, isTerminal),
        (snapshot) =>
          Effect.promise(async () => {
            revisions.push(snapshot.revision);
            if (snapshot.revision === 1) {
              resolveFirst();
              await firstGate;
            }
          }),
      ),
    );
    try {
      await firstSeen;
      await Effect.runPromise(Effect.yieldNow);
      expect(isTerminal).toHaveBeenCalledTimes(3);
      expect(pulls).toBe(1);
      expect(revisions).toEqual([1]);
      releaseFirst();
      await Effect.runPromise(Fiber.join(fiber));
      expect(revisions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      expect(pulls).toBe(1);
    } finally {
      releaseFirst();
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  it("interrupts a blocked snapshot offer and releases its reader without reading ahead", async () => {
    const encoder = new TextEncoder();
    const frames = Array.from({ length: 9 }, (_, index) => index + 1).map(
      (revision) =>
        `event: snapshot\nid: cursor-${revision}\ndata: ${JSON.stringify({
          id: "j_demo",
          type: "export",
          state: "running",
          revision,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:01Z",
        })}\n\n`,
    );
    let pulls = 0;
    let wasCancelled = false;
    let resolveThirdPull!: () => void;
    let resolveFirst!: () => void;
    let releaseFirst!: () => void;
    const thirdPull = new Promise<void>((resolve) => (resolveThirdPull = resolve));
    const firstSeen = new Promise<void>((resolve) => (resolveFirst = resolve));
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const index = pulls++;
          if (index === 2) resolveThirdPull();
          if (index < frames.length) controller.enqueue(encoder.encode(frames[index]));
        },
        cancel() {
          wasCancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const api = createApiClient(
      { serverBaseUrl: "https://video.example.test", authentication: { type: "none" } },
      () =>
        Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" } })),
    );
    const fiber = Effect.runFork(
      Stream.runForEach(
        observeSnapshots<JobSnapshot, JobSnapshot>(api, "jobs/j_demo/events", Job),
        (snapshot) =>
          Effect.tryPromise({
            try: async () => {
              if (snapshot.revision === 1) {
                resolveFirst();
                await firstGate;
              }
            },
            catch: (cause) => (cause instanceof Error ? cause : new Error("consumer failed")),
          }),
      ),
    );

    try {
      await firstSeen;
      await thirdPull;
      await Effect.runPromise(Effect.yieldNow);
      expect(pulls).toBe(3);
      expect(body.locked).toBe(true);
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(wasCancelled).toBe(true);
      expect(body.locked).toBe(false);
      expect(pulls).toBe(3);
    } finally {
      releaseFirst();
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  it.each([400, 401, 403, 404, 409, 422])(
    "does not retry permanent HTTP %i streams",
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          Response.json(
            { error: { code: "unauthorized", message: "Denied", requestId: "r1" } },
            { status },
          ),
        ),
      );
      const api = createApiClient(
        { serverBaseUrl: "https://video.example.test", authentication: { type: "none" } },
        fetch,
      );

      const failure = await Effect.runPromise(
        Stream.runCollect(
          observeSnapshots<JobSnapshot, JobSnapshot>(api, "jobs/j_demo/events", Job),
        ),
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiFailure);
      expect(failure).toMatchObject({
        status,
        code: "unauthorized",
        requestId: "r1",
        message: "Denied",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.effect("caps exponential retries at 10s and resets after an empty successful connection", () =>
    Effect.gen(function* () {
      const cancelledBodies: number[] = [];
      const signals: AbortSignal[] = [];
      let requests = 0;
      const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
        const request = ++requests;
        signals.push(init!.signal!);
        if (request <= 8 || request === 10) {
          if (request % 3 === 1) return Promise.reject(new TypeError("Network unavailable."));
          const body = new ReadableStream<Uint8Array>(
            { cancel: () => void cancelledBodies.push(request) },
            { highWaterMark: 0 },
          );
          return Promise.resolve(new Response(body, { status: request % 3 === 2 ? 429 : 503 }));
        }
        if (request === 9)
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
            ),
          );
        return Promise.resolve(
          new Response(
            `event: snapshot\nid: terminal\ndata: ${JSON.stringify({
              id: "j_demo",
              type: "export",
              state: "succeeded",
              revision: 1,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:01Z",
            })}\n\n`,
          ),
        );
      });
      const api = createApiClient(
        { serverBaseUrl: "https://video.example.test", authentication: { type: "none" } },
        fetch,
      );
      const fiber = yield* Stream.runCollect(
        observeSnapshots<JobSnapshot, JobSnapshot>(api, "jobs/j_demo/events", Job),
      ).pipe(Effect.forkScoped);
      const settle = Effect.yieldNow.pipe(
        Effect.andThen(
          Effect.promise(async () => {
            for (let turn = 0; turn < 50; turn++) await Promise.resolve();
          }),
        ),
        Effect.andThen(Effect.yieldNow),
      );
      yield* settle;
      expect(requests).toBe(1);
      const delays = [250, 500, 1000, 2000, 4000, 8000, 10_000, 10_000, 250, 500];
      for (const [index, delay] of delays.entries()) {
        yield* TestClock.adjust(delay - 1);
        yield* settle;
        expect(requests).toBe(index + 1);
        expect(signals[index].aborted).toBe(true);
        yield* TestClock.adjust(1);
        yield* settle;
        expect(requests).toBe(index + 2);
      }
      const snapshots = yield* Fiber.join(fiber);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].state).toBe("succeeded");
      expect(cancelledBodies).toEqual([2, 3, 5, 6, 8]);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    }),
  );

  it("terminates a successful response with no body without retrying", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(null)));
    const api = createApiClient(
      { serverBaseUrl: "https://video.example.test", authentication: { type: "none" } },
      fetch,
    );
    await expect(
      Effect.runPromise(
        Stream.runCollect(
          observeSnapshots<JobSnapshot, JobSnapshot>(api, "jobs/j_demo/events", Job),
        ),
      ),
    ).rejects.toThrow("The snapshot stream response had no body.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("interrupts pending headers and cancels a late body without cancelling a server job", async () => {
    let resolveResponse!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => (resolveStarted = resolve));
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      resolveStarted();
      return new Promise<Response>((resolve) => (resolveResponse = resolve));
    });
    const api = createApiClient(
      { serverBaseUrl: "https://video.example.test", authentication: { type: "none" } },
      fetch,
    );
    const fiber = Effect.runFork(
      Stream.runCollect(observeSnapshots<JobSnapshot, JobSnapshot>(api, "jobs/j_demo/events", Job)),
    );
    let resolveCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => (resolveCancelled = resolve));
    const cancel = vi.fn(resolveCancelled);
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    try {
      await started;
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(requestSignal?.aborted).toBe(true);
      resolveResponse(new Response(body));
      await cancelled;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toMatch(/\/jobs\/j_demo\/events$/);
      expect(fetch.mock.calls[0][1]?.method).toBeUndefined();
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  it("interrupts a pending reader and releases it exactly once", async () => {
    let resolveRead!: () => void;
    const reading = new Promise<void>((resolve) => (resolveRead = resolve));
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      { pull: resolveRead, cancel },
      { highWaterMark: 0 },
    );
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return Promise.resolve(new Response(body));
    });
    const api = createApiClient(
      { serverBaseUrl: "https://video.example.test", authentication: { type: "none" } },
      fetch,
    );
    const fiber = Effect.runFork(
      Stream.runCollect(observeSnapshots<JobSnapshot, JobSnapshot>(api, "jobs/j_demo/events", Job)),
    );
    try {
      await reading;
      expect(body.locked).toBe(true);
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      expect(requestSignal?.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  it("aborts fetch and releases the stream reader when observation is interrupted", async () => {
    const encoder = new TextEncoder();
    let readerCancelled = false;
    let requestSignal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: snapshot\nid: cursor-1\ndata: ${JSON.stringify({
              id: "j_demo",
              type: "export",
              state: "running",
              revision: 1,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:01Z",
            })}\n\n`,
          ),
        );
      },
      cancel() {
        readerCancelled = true;
      },
    });
    const api = createApiClient(
      { serverBaseUrl: "https://video.example.test", authentication: { type: "none" } },
      (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return Promise.resolve(
          new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
        );
      },
    );

    await Effect.runPromise(
      Stream.runCollect(
        Stream.take(observeSnapshots<JobSnapshot, JobSnapshot>(api, "jobs/j_demo/events", Job), 1),
      ),
    );

    expect(requestSignal?.aborted).toBe(true);
    expect(readerCancelled).toBe(true);
  });
});
