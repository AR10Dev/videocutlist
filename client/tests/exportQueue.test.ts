import { describe, expect, it } from "vitest";
import { parseBatchExportSubmission } from "../src/features/export/queueResponse";

describe("export batch response", () => {
  it("preserves the batch and all child jobs", () => {
    const jobs = [{ id: "job-1", type: "export", state: "queued" }];
    expect(parseBatchExportSubmission({ batchId: "batch-1", jobs })).toEqual({
      batchId: "batch-1",
      jobs,
    });
  });

  it("rejects the old singleton job response", () => {
    expect(() => parseBatchExportSubmission({ id: "job-1", state: "queued" })).toThrow(
      "Invalid export batch response",
    );
  });
});
