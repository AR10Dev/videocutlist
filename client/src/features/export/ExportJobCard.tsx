import { For, Show } from "solid-js";
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Download,
  LoaderCircle,
  RotateCcw,
  X,
} from "lucide-solid";
import type { components } from "../../generated/api";
import { BatchDownload } from "./BatchDownload";
import { OutputDownload } from "./OutputDownload";

type Job = components["schemas"]["Job"];
type Destination = components["schemas"]["Destination"];

export const jobOutputNames = (job: Job): string[] =>
  job.result?.outputNames ?? (job.result?.outputName ? [job.result.outputName] : []);

export const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1000) return `${bytes.toLocaleString()} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "bytes";
  for (const next of units) {
    value /= 1000;
    unit = next;
    if (value < 1000 || next === units.at(-1)) break;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
};

export const formatJobDate = (value?: string) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export const strategyLabel = (value?: string) => {
  switch (value) {
    case "stream_copy_preferred":
      return "Stream copy preferred";
    case "stream_copy":
      return "Stream copy fallback";
    case "precise_reencode":
      return "Precise re-encode";
    case "hybrid_smart_cut":
      return "Hybrid smart cut";
    default:
      return value || "Not reported";
  }
};

const selectionLabel = (value?: string) =>
  value === "gaps" ? "Gaps between cuts" : value === "segments" ? "Included cuts" : "Not reported";

const destinationKindLabel = (value?: string) => {
  switch (value) {
    case "download":
      return "Browser download";
    case "archive":
      return "Server archive";
    case "source_adjacent":
      return "Beside source (configured)";
    default:
      return "Not reported";
  }
};

function destinationLabel(
  destinations: readonly Destination[],
  id: string | undefined,
  kind: string | undefined,
) {
  return (
    destinations.find((destination) => destination.id === id)?.label ?? destinationKindLabel(kind)
  );
}

export function ExportJobCard(props: {
  job: Job;
  ordinal: number;
  batchId?: string;
  destinations: () => Destination[];
  canDownloadBatch?: boolean;
  onCancel?: (id: string) => Promise<unknown>;
  onRetry?: (id: string) => Promise<unknown>;
}) {
  const outputs = () => jobOutputNames(props.job);
  const running = () => props.job.state === "queued" || props.job.state === "running";
  const destinationKind = () => props.job.result?.destinationKind;
  const downloadable = () => props.job.state === "succeeded" && destinationKind() === "download";
  const warningDetails = () => props.job.warningDetails ?? [];
  const outputFailures = () => props.job.result?.outputFailures ?? [];
  const selectedStreams = () => props.job.selectedStreams ?? [];
  const destination = () =>
    destinationLabel(props.destinations(), props.job.result?.destinationId, destinationKind());

  return (
    <article class="export-job-card" aria-label={`Export job ${props.ordinal}`}>
      <header class="export-job-card-heading">
        <div>
          <h4>
            {props.job.mediaLabel ?? props.job.projectItemId ?? `Export job ${props.ordinal}`}
          </h4>
          <p>
            <code>{props.job.id}</code>
            <Show when={props.job.projectRevision}> · revision {props.job.projectRevision}</Show>
          </p>
        </div>
        <span
          class={`badge badge-sm ${
            props.job.state === "succeeded"
              ? "badge-success"
              : props.job.state === "failed"
                ? "badge-error"
                : props.job.state === "cancelled"
                  ? "badge-warning"
                  : "badge-neutral"
          }`}
        >
          {props.job.state}
        </span>
      </header>

      <div class="export-job-progress" aria-label={`Export job ${props.ordinal} status`}>
        <Show when={props.job.progress !== undefined}>
          <progress
            class="progress progress-primary"
            value={Math.round((props.job.progress ?? 0) * 100)}
            max="100"
            aria-label={`Export job ${props.ordinal} progress`}
          />
          <span>{Math.round((props.job.progress ?? 0) * 100)}%</span>
        </Show>
        <Show when={props.job.state === "running"}>
          <LoaderCircle class="spin" size={14} aria-label="Export running" />
        </Show>
      </div>

      <dl class="export-job-facts">
        <dt>Requested cut</dt>
        <dd>{strategyLabel(props.job.strategy)}</dd>
        <dt>Applied cut</dt>
        <dd>{strategyLabel(props.job.appliedStrategy)}</dd>
        <dt>Arrangement</dt>
        <dd>
          {props.job.mode === "separate"
            ? "One output per cut"
            : props.job.mode === "merge"
              ? "One merged output"
              : "Not reported"}
        </dd>
        <dt>Selection</dt>
        <dd>{selectionLabel(props.job.selection)}</dd>
        <Show when={selectedStreams().length > 0}>
          <dt>Selected streams</dt>
          <dd>{selectedStreams().join(", ")}</dd>
        </Show>
        <dt>Started</dt>
        <dd>{formatJobDate(props.job.createdAt)}</dd>
        <dt>Updated</dt>
        <dd>{formatJobDate(props.job.updatedAt)}</dd>
      </dl>

      <Show when={props.job.errorCode}>
        {(code) => (
          <div class="alert alert-error alert-soft" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <span>Export failed: {code()}.</span>
          </div>
        )}
      </Show>

      <Show when={props.job.result}>
        {(result) => (
          <div class="export-job-result">
            <div class="export-result-heading">
              <h5>
                <Download size={15} aria-hidden="true" /> Published outputs
              </h5>
              <span class={props.job.verified ? "text-success" : "text-warning"}>
                {props.job.verified ? (
                  <>
                    <CheckCircle2 size={14} aria-hidden="true" /> Verified
                  </>
                ) : (
                  <>
                    <AlertTriangle size={14} aria-hidden="true" /> Review required
                  </>
                )}
              </span>
            </div>
            <dl class="export-job-facts">
              <dt>Destination</dt>
              <dd>{destination()}</dd>
              <dt>Destination type</dt>
              <dd>{destinationKindLabel(result().destinationKind)}</dd>
              <dt>Total size</dt>
              <dd>{formatBytes(result().sizeBytes)}</dd>
              <dt>Retained until</dt>
              <dd>{formatJobDate(result().retainUntil)}</dd>
            </dl>
            <Show
              when={outputs().length > 0}
              fallback={<p class="export-muted-note">The server did not publish an output name.</p>}
            >
              <ul class="export-output-list" aria-label={`Export job ${props.ordinal} outputs`}>
                <For each={outputs()}>
                  {(name, position) => (
                    <li>
                      <code>{name}</code>
                      <Show when={downloadable()}>
                        <OutputDownload jobId={props.job.id} position={position()} name={name} />
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show
              when={
                downloadable() && props.canDownloadBatch && props.batchId && outputs().length > 1
              }
            >
              <BatchDownload batchId={props.batchId!} outputCount={outputs().length} />
            </Show>
            <Show when={!downloadable() && result().destinationKind}>
              <p class="export-muted-note">
                These outputs were saved to the configured server destination; browser download
                actions are not available for this destination.
              </p>
            </Show>
            <Show when={result().appliedStrategies?.length}>
              <details class="export-job-subdetails">
                <summary>Applied strategy per cut</summary>
                <ul class="export-detail-list">
                  <For each={result().appliedStrategies}>
                    {(strategy) => (
                      <li>
                        Cut {strategy.segment}: {strategyLabel(strategy.strategy)}
                        <Show when={strategy.outputName}>
                          {" "}
                          · <code>{strategy.outputName}</code>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <Show when={outputFailures().length > 0}>
              <div class="alert alert-warning alert-soft" role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <div>
                  <strong>
                    {outputFailures().length} output failure
                    {outputFailures().length === 1 ? "" : "s"}
                  </strong>
                  <ul class="export-detail-list">
                    <For each={outputFailures()}>
                      {(failure) => (
                        <li>
                          Cut {failure.segment}: {failure.message} ({failure.code})
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={props.job.warnings?.length || warningDetails().length}>
        <details class="export-job-subdetails" open>
          <summary>Warnings and review notes</summary>
          <ul class="export-detail-list">
            <For each={props.job.warnings ?? []}>{(warning) => <li>{warning}</li>}</For>
            <For each={warningDetails()}>
              {(finding) => (
                <li>
                  {finding.code}: {finding.message}
                  <Show when={finding.streamIndex !== undefined}>
                    {" "}
                    · stream {finding.streamIndex}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>

      <Show when={running() && props.onCancel}>
        <div class="export-job-actions">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            onClick={() => void props.onCancel!(props.job.id)}
          >
            <X size={15} aria-hidden="true" /> Cancel job
          </button>
        </div>
      </Show>
      <Show when={props.job.state === "failed" && props.job.type === "export" && props.onRetry}>
        <div class="export-job-actions">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            onClick={() => void props.onRetry!(props.job.id)}
          >
            <RotateCcw size={15} aria-hidden="true" /> Retry job
          </button>
        </div>
      </Show>
    </article>
  );
}
