type QueryKey = readonly unknown[];

type CancelJobOptions = {
  jobId: string;
  signal: AbortSignal;
  cancel: (jobId: string, signal: AbortSignal) => Promise<Response>;
  cancelQueries: (options: { queryKey: QueryKey }) => Promise<unknown>;
  invalidateQueries: (options: { queryKey: QueryKey }) => Promise<unknown>;
  jobQueryKey: QueryKey;
  projectQueryKey: QueryKey;
};

export async function cancelJobLifecycle({
  jobId,
  signal,
  cancel,
  cancelQueries,
  invalidateQueries,
  jobQueryKey,
  projectQueryKey,
}: CancelJobOptions) {
  const response = await cancel(jobId, signal);
  if (!response.ok) throw new Error("Job could not be cancelled. Try again.");
  await cancelQueries({ queryKey: jobQueryKey });
  await invalidateQueries({ queryKey: jobQueryKey });
  await invalidateQueries({ queryKey: projectQueryKey });
  await invalidateQueries({ queryKey: ["media"] });
}
