import type * as EffectApiTypes from "../../generated/effect-api";
import * as Schema from "effect/Schema";
import { BatchExportSubmission as BatchExportSubmissionSchema } from "../../generated/effect-api";

export type BatchExportSubmission = EffectApiTypes.BatchExportSubmission;
export type ExportJob = EffectApiTypes.Job;
type Batch = EffectApiTypes.Batch;
export const isJobActive = (job: Pick<ExportJob, "state"> | undefined) =>
  job?.state === "queued" || job?.state === "running";

export const selectBatchJob = (jobs: readonly ExportJob[]) => jobs.find(isJobActive) ?? jobs[0];

export function idempotencyKeyForAttempt<Body>(
  uncertain: { key: string; body: Body } | undefined,
  body: Body,
  freshKey: () => string,
): string {
  return uncertain && JSON.stringify(uncertain.body) === JSON.stringify(body)
    ? uncertain.key
    : freshKey();
}

export const isBatchActive = (batch: Batch | undefined) =>
  Boolean(
    batch &&
    (batch.state === "queued" || batch.state === "running" || batch.jobs.some(isJobActive)),
  );

/** The export endpoint always returns a batch, even when it contains one item. */
export function parseBatchExportSubmission(value: unknown): BatchExportSubmission {
  try {
    return Schema.decodeUnknownSync(BatchExportSubmissionSchema)(value) as BatchExportSubmission;
  } catch (cause) {
    throw new Error("Invalid export batch response", { cause });
  }
}
