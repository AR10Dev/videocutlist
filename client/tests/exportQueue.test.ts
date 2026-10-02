import { describe, expect, it } from "vitest";
import { parseBatchExportSubmission } from "../src/features/export/queueResponse";

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
  ])("rejects malformed child jobs before polling and queue rendering: %s", (job) => {
    expect(() => parseBatchExportSubmission({ batchId: "batch-1", jobs: [job] })).toThrow(
      "Invalid export batch response",
    );
  });
});
