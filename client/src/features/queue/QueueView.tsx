import { For, Show } from "solid-js";
import { useWorkspace } from "../app/WorkspaceContext";

export function QueueView() {
  const { batches, cancelBatch, cancelChildJob, retryChildJob } = useWorkspace();
  return (
    <Show when={batches().length > 0}>
      <section class="queue-panel" aria-labelledby="queue-heading">
        <h2 id="queue-heading">Export queue</h2>
        <For each={batches()}>
          {(batch) => (
            <article aria-label={`Batch ${batch.batchId}`}>
              <h3>
                Batch {batch.batchId} · revision {batch.projectRevision ?? "unknown"}
              </h3>
              <p>
                {batch.state} · {Math.round(batch.progress * 100)}%
              </p>
              <Show when={batch.state === "queued" || batch.state === "running"}>
                <button onClick={() => void cancelBatch(batch.batchId)}>Cancel batch</button>
              </Show>
              <ul>
                <For each={batch.jobs}>
                  {(job) => (
                    <li>
                      {job.type} · {job.mediaLabel ?? job.projectItemId ?? "media"} · {job.state}
                      {job.progress !== undefined ? ` · ${Math.round(job.progress * 100)}%` : ""}
                      {job.errorCode ? ` · ${job.errorCode}` : ""}
                      {job.warnings?.length ? ` · ${job.warnings.join(", ")}` : ""}
                      {job.result?.outputName ? ` · ${job.result.outputName}` : ""}
                      {job.result?.outputNames?.length
                        ? ` · ${job.result.outputNames.join(", ")}`
                        : ""}{" "}
                      <Show when={job.state === "queued" || job.state === "running"}>
                        <button onClick={() => void cancelChildJob(job.id)}>Cancel job</button>
                      </Show>
                      <Show when={job.state === "failed" && job.type === "export"}>
                        <button onClick={() => void retryChildJob(job.id)}>Retry</button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </article>
          )}
        </For>
      </section>
    </Show>
  );
}
