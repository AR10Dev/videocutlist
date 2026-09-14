import { For, Show } from "solid-js";
import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-solid";
import type { components } from "../../generated/api";
import { useWorkspace } from "../app/WorkspaceContext";
import { ExportJobCard, jobOutputNames } from "../export/ExportJobCard";
import { BatchDownload } from "../export/BatchDownload";

type Batch = components["schemas"]["Batch"];
type Destination = components["schemas"]["Destination"];

function BatchCard(props: {
  batch: Batch;
  ordinal: number;
  destinations: () => Destination[];
  cancelBatch: (id: string) => Promise<unknown>;
  cancelChildJob: (id: string) => Promise<unknown>;
  retryChildJob: (id: string) => Promise<unknown>;
}) {
  const completedJobs = () => props.batch.jobs.filter((job) => job.state === "succeeded");
  const outputs = () => completedJobs().flatMap((job) => jobOutputNames(job));
  const allDownloadable = () =>
    props.batch.jobs.length > 0 &&
    props.batch.jobs.every(
      (job) => job.state === "succeeded" && job.result?.destinationKind === "download",
    );
  const serverDestinations = () => [
    ...new Set(
      completedJobs()
        .filter(
          (job) =>
            job.result?.destinationKind !== undefined && job.result.destinationKind !== "download",
        )
        .map(
          (job) =>
            props.destinations().find((destination) => destination.id === job.result?.destinationId)
              ?.label ?? "the configured server destination",
        ),
    ),
  ];

  return (
    <article class="queue-batch" aria-label={`Export batch ${props.ordinal}`}>
      <header class="queue-batch-heading">
        <div>
          <h3>Export batch</h3>
          <p>
            <code>{props.batch.batchId}</code>
            <Show when={props.batch.projectRevision}>
              {" "}
              · revision {props.batch.projectRevision}
            </Show>
          </p>
        </div>
        <span
          class={`badge badge-sm ${
            props.batch.state === "succeeded"
              ? "badge-success"
              : props.batch.state === "failed"
                ? "badge-error"
                : props.batch.state === "cancelled"
                  ? "badge-warning"
                  : "badge-neutral"
          }`}
        >
          {props.batch.state}
        </span>
      </header>
      <div class="queue-batch-progress" aria-label={`Export batch ${props.ordinal} progress`}>
        <progress
          class="progress progress-primary"
          value={Math.round(props.batch.progress * 100)}
          max="100"
        />
        <span>{Math.round(props.batch.progress * 100)}%</span>
      </div>
      <p class="queue-batch-summary">
        {props.batch.jobs.length} job{props.batch.jobs.length === 1 ? "" : "s"} · {outputs().length}{" "}
        output{outputs().length === 1 ? "" : "s"} published
      </p>

      <Show when={props.batch.state === "queued" || props.batch.state === "running"}>
        <div class="queue-batch-actions">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            onClick={() => void props.cancelBatch(props.batch.batchId)}
          >
            Cancel batch
          </button>
        </div>
      </Show>
      <Show when={allDownloadable() && outputs().length > 1}>
        <BatchDownload batchId={props.batch.batchId} outputCount={outputs().length} />
      </Show>
      <Show when={serverDestinations().length > 0}>
        <div class="queue-destination-notes" aria-label="Server destination results">
          <For each={serverDestinations()}>
            {(destination) => <p role="status">Clips created in {destination}.</p>}
          </For>
        </div>
      </Show>

      <div class="queue-job-list" aria-label="Export batch jobs">
        <For each={props.batch.jobs}>
          {(job, index) => (
            <ExportJobCard
              job={job}
              ordinal={index() + 1}
              batchId={props.batch.batchId}
              destinations={props.destinations}
              onCancel={props.cancelChildJob}
              onRetry={props.retryChildJob}
            />
          )}
        </For>
      </div>
      <Show when={props.batch.jobs.length === 0}>
        <p class="export-muted-note">This batch has no child jobs.</p>
      </Show>
    </article>
  );
}

export function QueueView() {
  const workspace = useWorkspace();
  const { batches, destinations, cancelBatch, cancelChildJob, retryChildJob } = workspace;
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
    <section class="queue-panel" aria-labelledby="queue-heading">
      <header class="queue-heading-row">
        <div>
          <h2 id="queue-heading">Export queue</h2>
          <p class="queue-description">Exports continue while you keep editing.</p>
        </div>
        <div class="queue-heading-actions">
          <span class="badge badge-sm">{batches().length} total</span>
          <button
            class="btn btn-ghost btn-sm btn-square"
            type="button"
            title="Refresh export queue"
            aria-label="Refresh export queue"
            disabled={workspace.batchesRefreshing()}
            onClick={workspace.refreshBatches}
          >
            <RefreshCw
              classList={{ spin: workspace.batchesRefreshing() }}
              size={15}
              aria-hidden="true"
            />
          </button>
        </div>
      </header>
      <Show when={workspace.batchesError()}>
        {(message) => (
          <div class="alert alert-error alert-soft" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <span>{message()}</span>
            <button class="btn btn-ghost btn-xs" type="button" onClick={workspace.refreshBatches}>
              Retry
            </button>
          </div>
        )}
      </Show>
      <Show when={workspace.batchesLoading() && !batches().length}>
        <div class="export-loading" role="status" aria-busy="true">
          <LoaderCircle class="spin" size={16} aria-hidden="true" /> Loading export queue…
        </div>
      </Show>
      <Show
        when={batches().length > 0}
        fallback={
          <Show when={!workspace.batchesLoading()}>
            <p role="status">No export jobs yet. Submitted clips will appear here.</p>
          </Show>
        }
      >
        <div class="queue-batch-list">
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
        </div>
        <Show when={history().length > 0}>
          <details class="collapse collapse-arrow queue-history">
            <summary class="collapse-title">Completed history ({history().length})</summary>
            <div class="collapse-content">
              <div class="queue-batch-list">
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
            </div>
          </details>
        </Show>
      </Show>
    </section>
  );
}
