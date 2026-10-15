import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import { BatchExportSubmission, type Batch, type Job } from "../src/generated/effect-api";
import { createExportQueue } from "../src/features/export/queue";
import { decodeBatchSeeds, idempotencyKeyForAttempt } from "../src/features/export/queueResponse";
import { withControllerTestRoot } from "./controllerTestEnvironment";
import { describe, expect, it } from "vitest";

describe("export command submission", () => {
  it("reuses only an uncertain command's key for its identical semantic body", () => {
    const uncertain = { key: "previous-key", body: { projectRevision: 7, itemIds: ["i_1"] } };
    const freshKey = () => "new-key";

    expect(
      idempotencyKeyForAttempt(uncertain, { projectRevision: 7, itemIds: ["i_1"] }, freshKey),
    ).toBe("previous-key");
    expect(
      idempotencyKeyForAttempt(uncertain, { projectRevision: 8, itemIds: ["i_1"] }, freshKey),
    ).toBe("new-key");
    expect(idempotencyKeyForAttempt(undefined, uncertain.body, freshKey)).toBe("new-key");
  });
});

describe("generated export batch response schema", () => {
  const decode = Schema.decodeUnknownSync(BatchExportSubmission);

  it("rejects the old singleton job response", () => {
    expect(() => decode({ id: "job-1", state: "queued" })).toThrow();
  });

  const validChild = {
    id: "j_0123456789ab",
    type: "export",
    state: "queued",
    revision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const responseWith = (job: unknown) => ({ batchId: "b_0123456789ab", jobs: [job] });

  it("accepts a valid child job", () => {
    expect(decode(responseWith(validChild)).jobs).toHaveLength(1);
  });

  it.each([
    ["null", null],
    ["revision type", { ...validChild, revision: "not-a-revision" }],
    ["state", { ...validChild, state: "unknown" }],
    ["progress", { ...validChild, progress: 2 }],
    ["missing createdAt", (({ createdAt: _createdAt, ...job }) => job)(validChild)],
    ["revision", { ...validChild, revision: 0 }],
  ])("rejects an invalid child %s before polling and queue rendering", (_field, job) => {
    expect(() => decode(responseWith(job))).toThrow();
  });
});

describe("decoded queue seeds", () => {
  it("ignores malformed entries independently and preserves valid seeds", () => {
    const valid = { batchId: "b_valid", state: "succeeded", progress: 1, jobs: [] };
    expect(
      decodeBatchSeeds([null, { ...valid, progress: 2 }, valid, { state: "unknown" }]),
    ).toEqual([valid]);
  });
});

describe("export queue cancellation", () => {
  it("keeps completion-winning cancellation canonical for the same batch and job", async () => {
    const batchId = "b_cancel-owner";
    const jobId = "j_cancel-owner";
    const timestamp = "2026-01-01T00:00:00Z";
    const makeJob = (
      id: string,
      batchId: string,
      state: Job["state"],
      revision: number,
      result?: Job["result"],
    ): Job => ({
      id,
      batchId,
      type: "export",
      state,
      revision,
      progress: state === "succeeded" ? 1 : 0.5,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(result ? { result, verified: true } : {}),
    });
    const makeBatch = (batchId: string, state: Batch["state"], jobs: Job[]): Batch => ({
      batchId,
      projectId: "p_cancel-owner",
      projectRevision: 7,
      state,
      progress: state === "succeeded" ? 1 : 0.5,
      jobs,
    });
    const runningBatch = makeBatch(batchId, "running", [makeJob(jobId, batchId, "running", 1)]);
    const succeededBatch = makeBatch(batchId, "succeeded", [
      makeJob(jobId, batchId, "succeeded", 2, {
        outputName: "camera-race.mkv",
        sizeBytes: 42,
        retainUntil: "2026-08-20T12:00:00Z",
        destinationKind: "download",
      }),
    ]);
    const otherBatch = makeBatch("b_other-owner", "succeeded", [
      makeJob("j_other-owner", "b_other-owner", "succeeded", 4),
    ]);
    let releaseCancellation!: () => void;
    const cancellationAck = new Promise<void>((resolve) => (releaseCancellation = resolve));
    let cancellationStarted = false;
    let eventController!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/api/v2/batches" && init?.method !== "DELETE")
        return Response.json({ items: [otherBatch], nextCursor: null });
      if (url.pathname === `/api/v2/batches/${batchId}/events`) {
        return new Response(
          new ReadableStream<Uint8Array>({ start: (controller) => (eventController = controller) }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.pathname === `/api/v2/batches/${batchId}` && init?.method === "DELETE") {
        cancellationStarted = true;
        await cancellationAck;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected export queue test request: ${init?.method ?? "GET"} ${url}`);
    };

    await withControllerTestRoot(
      ({ registry, server }) => {
        const context = Atom.make({
          projectId: "p_cancel-owner",
          selectedMediaId: "m_cancel-owner",
          revision: 7,
          editVersion: 0,
          generation: 1,
        });
        const queue = createExportQueue({
          server,
          context,
          currentContext: () => registry.get(context),
        });
        queue.acceptSubmission(runningBatch);
        return queue;
      },
      async (queue) => {
        await expect.poll(() => eventController).toBeDefined();
        queue.view.cancelBatch(batchId);
        await expect.poll(() => cancellationStarted).toBe(true);
        expect(queue.view.exportCancellationPending()).toBe(true);
        expect(queue.view.exportStatus()).toBe("Export batch cancellation requested.");

        eventController.enqueue(
          new TextEncoder().encode(
            `id: completion\nevent: snapshot\ndata: ${JSON.stringify(succeededBatch)}\n\n`,
          ),
        );
        await expect.poll(() => queue.view.exportStatus()).toBe("Export complete.");
        expect(queue.view.exportCancellationPending()).toBe(true);
        const completed = queue.view
          .batches()
          .find((candidate: Batch) => candidate.batchId === batchId);
        expect(completed).toMatchObject({
          batchId,
          projectId: "p_cancel-owner",
          projectRevision: 7,
          state: "succeeded",
        });
        expect(completed?.jobs).toMatchObject([
          {
            id: jobId,
            batchId,
            state: "succeeded",
            revision: 2,
            result: { outputName: "camera-race.mkv" },
          },
        ]);
        expect(
          queue.view.batches().find((candidate: Batch) => candidate.batchId === otherBatch.batchId),
        ).toMatchObject({
          batchId: otherBatch.batchId,
          state: "succeeded",
          jobs: [{ id: "j_other-owner", batchId: otherBatch.batchId, revision: 4 }],
        });

        releaseCancellation();
        await expect.poll(() => queue.view.exportCancellationPending()).toBe(false);
        expect(
          queue.view.batches().find((candidate: Batch) => candidate.batchId === batchId)?.state,
        ).toBe("succeeded");
      },
      { fetch },
    );
  });
});
