import { z } from "zod";
import type { components } from "../../generated/api";

export type BatchExportSubmission = components["schemas"]["BatchExportSubmission"];
export type ExportJob = components["schemas"]["Job"];
type Batch = components["schemas"]["Batch"];
const batchSubmission = z.object({
  batchId: z.string(),
  jobs: z.array(
    z.looseObject({
      id: z.string(),
      type: z.enum(["export", "detection", "library_scan"]),
      state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
});

export const isJobActive = (job: Pick<ExportJob, "state"> | undefined) =>
  job?.state === "queued" || job?.state === "running";

export const selectBatchJob = (jobs: readonly ExportJob[]) => jobs.find(isJobActive) ?? jobs[0];

export const isBatchActive = (batch: Batch | undefined) =>
  Boolean(
    batch &&
    (batch.state === "queued" || batch.state === "running" || batch.jobs.some(isJobActive)),
  );

/** The export endpoint always returns a batch, even when it contains one item. */
export function parseBatchExportSubmission(value: unknown): BatchExportSubmission {
  const parsed = batchSubmission.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.length ? issue.path.join(".") : "response";
    throw new Error(`Invalid export batch response: ${path}: ${issue.message}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}
