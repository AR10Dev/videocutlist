import { describe, expect, it } from "vitest";
import { parseBatchExportSubmission } from "../src/features/export/queueResponse";

describe("export batch response", () => {
  it("rejects the old singleton job response", () => {
    expect(() => parseBatchExportSubmission({ id: "job-1", state: "queued" })).toThrow(
      "Invalid export batch response",
    );
  });

  it.each([
    [null, "jobs.0"],
    [
      {
        id: "job-1",
        type: "export",
        state: "unknown",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      "jobs.0.state",
    ],
    [
      {
        id: "job-1",
        type: "export",
        state: "queued",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      "jobs.0.createdAt",
    ],
  ])("rejects malformed child jobs before polling and queue rendering: %s", (job, path) => {
    expect(() => parseBatchExportSubmission({ batchId: "batch-1", jobs: [job] })).toThrow(
      `Invalid export batch response: ${path}:`,
    );
  });
});
