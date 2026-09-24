import type { components } from "../../generated/api";

export type BatchExportSubmission = components["schemas"]["BatchExportSubmission"];
export type ExportJob = components["schemas"]["Job"];
type Batch = components["schemas"]["Batch"];

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
  if (!value || typeof value !== "object") throw new Error("Invalid export batch response.");
  const response = value as Partial<BatchExportSubmission>;
  if (typeof response.batchId !== "string" || !Array.isArray(response.jobs))
    throw new Error("Invalid export batch response.");
  return { batchId: response.batchId, jobs: response.jobs as ExportJob[] };
}
