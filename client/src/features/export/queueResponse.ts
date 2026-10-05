import type * as EffectApiTypes from "../../generated/effect-api";
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
