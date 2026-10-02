import { describe, expect, it } from "vitest";
import {
  idempotencyKeyForAttempt,
  parseBatchExportSubmission,
} from "../src/features/export/queueResponse";

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

describe("export batch response", () => {
  it("rejects the old singleton job response", () => {
    expect(() => parseBatchExportSubmission({ id: "job-1", state: "queued" })).toThrow(
      "Invalid export batch response",
    );
  });

  it.each([
    null,
    {
      id: "job-1",
      type: "export",
      state: "unknown",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "job-1",
      type: "export",
      state: "queued",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      progress: 2,
    },
    {
      id: "job-1",
      type: "export",
      state: "queued",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      batchId: "b_0123456789ab",
      jobs: [
        {
          id: "j_0123456789ab",
          type: "export",
          state: "queued",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          revision: "not-a-revision",
        },
      ],
    },
  ])("rejects malformed child jobs before polling and queue rendering: %s", (job) => {
    expect(() => parseBatchExportSubmission({ batchId: "batch-1", jobs: [job] })).toThrow(
      "Invalid export batch response",
    );
  });
});
