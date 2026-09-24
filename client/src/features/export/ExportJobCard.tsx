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

const containerLabel = (value?: string) =>
  value === "mp4" ? "MP4" : value === "mov" ? "MOV" : value === "mkv" ? "MKV" : "Not reported";

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
  childJobPending?: (id: string) => boolean;
  onCancel?: (id: string, batchId?: string) => Promise<unknown>;
  onRetry?: (id: string, batchId?: string) => Promise<unknown>;
}) {
  const outputs = () => jobOutputNames(props.job);
  const running = () => props.job.state === "queued" || props.job.state === "running";
  const destinationKind = () => props.job.result?.destinationKind;
  const downloadable = () => props.job.state === "succeeded" && destinationKind() === "download";
  const warningDetails = () => props.job.warningDetails ?? [];
  const warnings = () => [
    ...new Set(
      warningDetails().length
        ? warningDetails().map((warning) => warning.message)
        : (props.job.warnings ?? []),
    ),
  ];
  const outputFailures = () => props.job.result?.outputFailures ?? [];
  const selectedStreams = () => props.job.selectedStreams ?? [];
  const destination = () =>
    destinationLabel(props.destinations(), props.job.result?.destinationId, destinationKind());
  const actionPending = () => props.childJobPending?.(props.job.id) ?? false;

  return (
    <article class="export-job-card" aria-label={`Export job ${props.ordinal}`}>
      <header class="export-job-card-heading">
        <div>
          <h4>
            {props.job.mediaLabel ?? props.job.projectItemId ?? `Export job ${props.ordinal}`}
          </h4>
          <p>
            <code>{props.job.id}</code>
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

      <Show when={running()}>
        <div class="export-job-progress" aria-label={`Export job ${props.ordinal} status`}>
          <progress
            class="progress progress-primary"
            value={Math.round((props.job.progress ?? 0) * 100)}
            max="100"
            aria-label={`Export job ${props.ordinal} progress`}
          />
          <span>{Math.round((props.job.progress ?? 0) * 100)}%</span>
          <Show when={props.job.state === "running"}>
            <LoaderCircle class="spin" size={14} aria-label="Export running" />
          </Show>
        </div>
      </Show>

      <p class="export-job-summary">
        {strategyLabel(props.job.appliedStrategy ?? props.job.strategy)} ·{" "}
        {props.job.mode === "separate" ? "One output per cut" : "One merged output"} ·{" "}
        {selectionLabel(props.job.selection)}
        <Show when={selectedStreams().length > 0}>
          {` · Streams ${selectedStreams().join(", ")}`}
        </Show>
      </p>

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
                <Download size={15} aria-hidden="true" /> Output
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
            <p class="export-job-summary">
              {containerLabel(result().container ?? props.job.container)} · {destination()} ·{" "}
              {destinationKindLabel(result().destinationKind)} · {formatBytes(result().sizeBytes)}
            </p>
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

      <Show when={warnings().length}>
        <details class="export-job-subdetails collapse collapse-arrow">
          <summary class="collapse-title">Warnings and review notes ({warnings().length})</summary>
          <div class="collapse-content">
            <ul class="export-detail-list">
              <For each={warnings()}>{(warning) => <li>{warning}</li>}</For>
            </ul>
          </div>
        </details>
      </Show>

      <Show when={running() && props.onCancel}>
        <div class="export-job-actions">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            disabled={actionPending()}
            aria-busy={actionPending()}
            onClick={() => void props.onCancel!(props.job.id, props.batchId)}
          >
            <Show when={actionPending()} fallback={<X size={15} aria-hidden="true" />}>
              <span class="loading loading-spinner loading-xs" aria-hidden="true" />
            </Show>{" "}
            Cancel job
          </button>
        </div>
      </Show>
      <Show when={props.job.state === "failed" && props.job.type === "export" && props.onRetry}>
        <div class="export-job-actions">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            disabled={actionPending()}
            aria-busy={actionPending()}
            onClick={() => void props.onRetry!(props.job.id, props.batchId)}
          >
            <Show when={actionPending()} fallback={<RotateCcw size={15} aria-hidden="true" />}>
              <span class="loading loading-spinner loading-xs" aria-hidden="true" />
            </Show>{" "}
            Retry job
          </button>
        </div>
      </Show>
    </article>
  );
}
