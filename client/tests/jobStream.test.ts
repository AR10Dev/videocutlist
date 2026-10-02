import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api";
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
      encoder.encode(": keepalive\r\n\r\nevent: snapshot\r\nid: bad\ndata: {broken}\n\n"),
      encoder.encode("event: snapshot\r\nid: cursor-1\r\ndata: "),
      eventData.slice(0, splitAt + 2),
      eventData.slice(splitAt + 2),
      encoder.encode("\r\n\r\n"),
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
