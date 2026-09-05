import { For, Show } from "solid-js";
import type { components } from "../../generated/api";
import { useWorkspace } from "../app/WorkspaceContext";
import { BatchDownload } from "../export/BatchDownload";
import { OutputDownload } from "../export/OutputDownload";

type Batch = components["schemas"]["Batch"];
type Job = components["schemas"]["Job"];
type Destination = components["schemas"]["Destination"];

function outputNames(job: Job): string[] {
  return job.result?.outputNames ?? (job.result?.outputName ? [job.result.outputName] : []);
}

function BatchCard(props: {
  batch: Batch;
  ordinal: number;
  destinations: () => Destination[];
  cancelBatch: (id: string) => Promise<unknown>;
  cancelChildJob: (id: string) => Promise<unknown>;
  retryChildJob: (id: string) => Promise<unknown>;
}) {
  const outputs = () => props.batch.jobs.flatMap((job) => outputNames(job));
  const downloadable = () =>
    outputs().length > 1 &&
    props.batch.jobs.some((job) => outputNames(job).length > 0) &&
    props.batch.jobs.every(
      (job) => job.state === "succeeded" && job.result?.destinationKind === "download",
    );
  const destinationLabel = (job: Job) =>
    props.destinations().find((destination) => destination.id === job.result?.destinationId)
      ?.label ?? "the configured server destination";

  return (
    <article class="card card-border card-sm" aria-label={`Export batch ${props.ordinal}`}>
      <div class="card-body">
        <h3 class="card-title text-base">Export batch {props.ordinal}</h3>
        <p role="status">
          {props.batch.state} · {Math.round(props.batch.progress * 100)}%
        </p>
        <progress
          class="progress progress-primary"
          value={Math.round(props.batch.progress * 100)}
          max="100"
          aria-label={`Export batch ${props.ordinal} progress`}
        />
        <Show when={props.batch.state === "queued" || props.batch.state === "running"}>
          <div class="card-actions">
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              onClick={() => void props.cancelBatch(props.batch.batchId)}
            >
              Cancel batch
            </button>
          </div>
        </Show>
        <Show when={downloadable()}>
          <BatchDownload batchId={props.batch.batchId} outputCount={outputs().length} />
        </Show>
        <ul class="list" aria-label="Export batch jobs">
          <For each={props.batch.jobs}>
            {(job) => (
              <li class="list-row">
                <span>
                  {job.type} · {job.mediaLabel ?? job.projectItemId ?? "media"} · {job.state}
                  {job.progress !== undefined ? ` · ${Math.round(job.progress * 100)}%` : ""}
                  {job.errorCode ? ` · ${job.errorCode}` : ""}
                  {job.warnings?.length ? ` · ${job.warnings.join(", ")}` : ""}
                  {job.result?.outputName ? ` · ${job.result.outputName}` : ""}
                  {job.result?.outputNames?.length ? ` · ${job.result.outputNames.join(", ")}` : ""}
                </span>
                <Show
                  when={job.state === "succeeded" && job.result?.destinationKind === "download"}
                >
                  <For each={outputNames(job)}>
                    {(name, position) => (
                      <OutputDownload jobId={job.id} position={position()} name={name} />
                    )}
                  </For>
                </Show>
                <Show
                  when={
                    job.state === "succeeded" &&
                    job.result?.destinationKind !== undefined &&
                    job.result.destinationKind !== "download"
                  }
                >
                  <p role="status">Clips created in {destinationLabel(job)}.</p>
                </Show>
                <Show when={job.state === "queued" || job.state === "running"}>
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => void props.cancelChildJob(job.id)}
                  >
                    Cancel job
                  </button>
                </Show>
                <Show when={job.state === "failed" && job.type === "export"}>
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => void props.retryChildJob(job.id)}
                  >
                    Retry
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </div>
    </article>
  );
}

export function QueueView() {
  const { batches, destinations, cancelBatch, cancelChildJob, retryChildJob } = useWorkspace();
  const activeOrRecent = () => {
    const current = batches();
    const visible = current.filter(
      (batch) => batch.state === "queued" || batch.state === "running",
    );
    const recentTerminal = current.find(
      (batch) => batch.state !== "queued" && batch.state !== "running",
    );
    if (recentTerminal) visible.push(recentTerminal);
    return visible;
  };
  const history = () => {
    const visible = new Set(activeOrRecent().map((batch) => batch.batchId));
    return batches().filter((batch) => !visible.has(batch.batchId));
  };

  return (
    <Show when={batches().length > 0}>
      <section class="queue-panel flex flex-col gap-4 p-4" aria-labelledby="queue-heading">
        <h2 id="queue-heading">Export queue</h2>
        <For each={activeOrRecent()}>
          {(batch, index) => (
            <BatchCard
              batch={batch}
              ordinal={index() + 1}
              destinations={destinations}
              cancelBatch={cancelBatch}
              cancelChildJob={cancelChildJob}
              retryChildJob={retryChildJob}
            />
          )}
        </For>
        <Show when={history().length > 0}>
          <details class="collapse collapse-arrow">
            <summary class="collapse-title">Completed history ({history().length})</summary>
            <div class="collapse-content">
              <For each={history()}>
                {(batch, index) => (
                  <BatchCard
                    batch={batch}
                    ordinal={activeOrRecent().length + index() + 1}
                    destinations={destinations}
                    cancelBatch={cancelBatch}
                    cancelChildJob={cancelChildJob}
                    retryChildJob={retryChildJob}
                  />
                )}
              </For>
            </div>
          </details>
        </Show>
      </section>
    </Show>
  );
}
