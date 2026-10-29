import { isActiveState } from "../queue/jobState";
import * as Schema from "effect/Schema";
import { Batch as BatchSchema } from "../../generated/effect-api";
import type * as EffectApiTypes from "../../generated/effect-api";
export type ExportJob = EffectApiTypes.Job;
type Batch = EffectApiTypes.Batch;
export const isJobActive = (job: Pick<ExportJob, "state"> | undefined) => isActiveState(job?.state);

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
  Boolean(batch && (isActiveState(batch.state) || batch.jobs.some(isJobActive)));

/** Decode independently so one malformed entry never becomes an observation seed. */
export function decodeBatchSeeds(entries: readonly unknown[]) {
  return entries.flatMap((entry) => {
    try {
      return [Schema.decodeUnknownSync(BatchSchema)(entry)];
    } catch {
      return [];
    }
  });
}
