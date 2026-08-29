export type PollableJob = { state: string };

export const jobPollInterval = (job: PollableJob | undefined, intervalMs: number) =>
  job && !["succeeded", "failed", "cancelled"].includes(job.state) ? intervalMs : false;
