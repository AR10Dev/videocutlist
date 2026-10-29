import type * as EffectApiTypes from "../../generated/effect-api";
import { Notice } from "../../components/Notice";
import { For, Show, createMemo } from "solid-js";
import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-solid";
import { useWorkspace } from "../../app/WorkspaceContext";
import { ExportJobCard, jobOutputNames } from "../export/ExportJobCard";
import { OutputDownload } from "../export/OutputDownload";
import { BatchDownload } from "../export/BatchDownload";
import { isBatchActive } from "../export/queueResponse";

type Batch = EffectApiTypes.Batch;
type Destination = EffectApiTypes.DestinationsResponse["destinations"][number];

function BatchCard(props: {
  batch: Batch;
  ordinal: number;
  destinations: () => Destination[];
  cancelBatch: (id: string) => void;
  cancelChildJob: (id: string, batchId?: string) => void;
  retryChildJob: (id: string, batchId?: string) => void;
  childJobPending: (id: string) => boolean;
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
          <strong>{props.batch.jobs[0]?.mediaLabel ?? `Export ${props.ordinal}`}</strong>
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
      <Show when={isBatchActive(props.batch)}>
        <div class="queue-batch-progress" aria-label={`Export batch ${props.ordinal} progress`}>
          <progress
            class="progress progress-primary"
            value={Math.round(props.batch.progress * 100)}
            max="100"
          />
          <span>{Math.round(props.batch.progress * 100)}%</span>
        </div>
      </Show>
      <p class="queue-batch-summary">
        {props.batch.jobs.length} job{props.batch.jobs.length === 1 ? "" : "s"} · {outputs().length}{" "}
        output{outputs().length === 1 ? "" : "s"} published
      </p>

      <Show when={isBatchActive(props.batch)}>
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

      <Show when={allDownloadable() && outputs().length === 1}>
        <For each={completedJobs()}>
          {(job) => (
            <For each={jobOutputNames(job)}>
              {(name, position) => (
                <OutputDownload jobId={job.id} position={position()} name={name} />
              )}
            </For>
          )}
        </For>
      </Show>
      <details>
        <summary class="cursor-pointer text-sm">Job details</summary>
        <div class="queue-job-list" aria-label="Export batch jobs">
          <For each={props.batch.jobs}>
            {(job, index) => (
              <ExportJobCard
                job={job}
                ordinal={index() + 1}
                batchId={props.batch.batchId}
                destinations={props.destinations}
                childJobPending={props.childJobPending}
                onCancel={props.cancelChildJob}
                onRetry={props.retryChildJob}
              />
            )}
          </For>
        </div>
      </details>
      <Show when={props.batch.jobs.length === 0}>
        <p class="export-muted-note">This batch has no child jobs.</p>
      </Show>
    </article>
  );
}

export function QueueView() {
  const workspace = useWorkspace();
  const { batches, destinations, cancelBatch, cancelChildJob, retryChildJob, childJobPending } =
    workspace.export;
  const batchById = createMemo(() => new Map(batches().map((batch) => [batch.batchId, batch])));
  const activeOrRecent = () => {
    const current = batches();
    const visible = current.filter(isBatchActive);
    const recentTerminal = current.find((batch) => !isBatchActive(batch));
    if (recentTerminal) visible.push(recentTerminal);
    return visible;
  };
  const history = () => {
    const visible = new Set(activeOrRecent().map((batch) => batch.batchId));
    return batches().filter((batch) => !visible.has(batch.batchId));
  };

  return (
    <section class="queue-panel" aria-label="Export queue">
      <header class="queue-heading-row">
        <div class="queue-heading-actions">
          <button
            class="btn btn-ghost btn-sm btn-square"
            type="button"
            title="Refresh export queue"
            aria-label="Refresh export queue"
            disabled={workspace.export.batchesRefreshing()}
            onClick={workspace.export.refreshBatches}
          >
            <RefreshCw
              classList={{ spin: workspace.export.batchesRefreshing() }}
              size={15}
              aria-hidden="true"
            />
          </button>
        </div>
      </header>
      <Show when={workspace.export.batchesError()}>
        {(message) => (
          <Notice variant="error">
            <CircleAlert size={16} aria-hidden="true" />
            <span>{message()}</span>
            <button
              class="btn btn-ghost btn-xs"
              type="button"
              onClick={workspace.export.refreshBatches}
            >
              Retry
            </button>
          </Notice>
        )}
      </Show>
      <Show when={workspace.export.batchesLoading() && !batches().length}>
        <div class="export-loading" role="status" aria-busy="true">
          <LoaderCircle class="spin" size={16} aria-hidden="true" /> Loading export queue…
        </div>
      </Show>
      <Show
        when={batches().length > 0}
        fallback={
          <Show when={!workspace.export.batchesLoading()}>
            <p role="status">No export jobs yet. Submitted clips will appear here.</p>
          </Show>
        }
      >
        <div class="queue-batch-list">
          <For each={activeOrRecent().map((batch) => batch.batchId)}>
            {(id, index) => (
              <Show when={batchById().get(id)}>
                {(batch) => (
                  <BatchCard
                    batch={batch()}
                    ordinal={index() + 1}
                    destinations={destinations}
                    cancelBatch={cancelBatch}
                    cancelChildJob={cancelChildJob}
                    retryChildJob={retryChildJob}
                    childJobPending={childJobPending}
                  />
                )}
              </Show>
            )}
          </For>
        </div>
        <Show when={history().length > 0}>
          <details class="collapse collapse-arrow queue-history">
            <summary class="collapse-title">History</summary>
            <div class="collapse-content">
              <div class="queue-batch-list">
                <For each={history().map((batch) => batch.batchId)}>
                  {(id, index) => (
                    <Show when={batchById().get(id)}>
                      {(batch) => (
                        <BatchCard
                          batch={batch()}
                          ordinal={activeOrRecent().length + index() + 1}
                          destinations={destinations}
                          cancelBatch={cancelBatch}
                          cancelChildJob={cancelChildJob}
                          retryChildJob={retryChildJob}
                          childJobPending={childJobPending}
                        />
                      )}
                    </Show>
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
