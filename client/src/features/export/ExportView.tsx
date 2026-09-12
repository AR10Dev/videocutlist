import { For, Show } from "solid-js";
import {
  Archive,
  CheckCircle2,
  CircleAlert,
  Download,
  FileOutput,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-solid";
import { formatTime, hybridSmartCutKnownIneligible } from "../preview/model";
import { useWorkspace } from "../app/WorkspaceContext";
import { summarizeExports } from "./summary";
import { QueueView } from "../queue/QueueView";
import { ExportJobCard } from "./ExportJobCard";

type ExportFinding = {
  severity: "allowed" | "warn" | "blocked";
  code: string;
  message: string;
  streamIndex?: number;
};

type Track = {
  index: number;
  type: string;
  codec: string;
  language?: string;
  disposition?: string[];
};

const findingTitle: Record<ExportFinding["severity"], string> = {
  allowed: "Allowed",
  warn: "Review",
  blocked: "Blocked",
};

const trackTypeLabel = (type: string) =>
  type === "video" ? "Video" : type === "audio" ? "Audio" : "Subtitle";

const trackLabel = (track: Track) => `${trackTypeLabel(track.type)}: ${track.codec}`;

const trackDetails = (track: Track) => {
  const details = [track.language, ...(track.disposition ?? [])].filter(Boolean);
  return details.length ? details.join(" · ") : "Supported stream";
};

const destinationTypeLabel = (kind?: string) => {
  switch (kind) {
    case "download":
      return "Browser download";
    case "archive":
      return "Server archive";
    case "source_adjacent":
      return "Beside source";
    default:
      return "Configured destination";
  }
};

function FindingIcon(props: { severity: ExportFinding["severity"] }) {
  return props.severity === "allowed" ? (
    <CheckCircle2 size={16} aria-hidden="true" />
  ) : props.severity === "blocked" ? (
    <CircleAlert size={16} aria-hidden="true" />
  ) : (
    <ShieldCheck size={16} aria-hidden="true" />
  );
}

type ExportViewProps = {
  dialog?: boolean;
  onClose?: () => void;
};

export function ExportView(props: ExportViewProps = {}) {
  const workspace = useWorkspace();
  const {
    selected,
    projectItems,
    editableItems,
    selectedExportItems,
    setSelectedExportItems,
    exportScope,
    setExportScope,
    exportItemIDs,
    exportJob,
    batchJobs,
    batchId,
    exportRevision,
    exportStatus,
    exportPending,
    destinationStatus,
    exportMode,
    exportSelection,
    cutStrategy,
    streamIndexes,
    destinations,
    destinationCapabilities,
    destinationId,
    filenameTemplate,
    preflight,
    preflightPending,
    preflightError,
    destinationsLoading,
    destinationsError,
    retryDestinations,
    batchLoading,
    batchError,
    exportJobLoading,
    exportJobError,
    export: exportFeature,
    tracks,
    exportProject,
    cancelExport,
  } = workspace;

  const summary = () =>
    summarizeExports(editableItems().filter((item) => exportItemIDs().includes(item.id)));
  const totalDuration = () => summary().reduce((total, item) => total + item.duration, 0);
  const emptyItem = () =>
    exportSelection() === "segments" ? summary().find((item) => item.outputs === 0) : undefined;
  const scopeLabel = () => {
    const itemIDs = exportItemIDs();
    if (itemIDs.length === 1) {
      return (
        projectItems().find((item) => item.id === itemIDs[0])?.media.name ?? "Selected media item"
      );
    }
    return `${itemIDs.length} project items`;
  };
  const includedCount = () => summary().reduce((total, item) => total + item.includedSegments, 0);
  const excludedCount = () => summary().reduce((total, item) => total + item.excludedSegments, 0);
  const requestedRanges = () => summary().reduce((total, item) => total + item.ranges.length, 0);
  const expectedOutputs = () => summary().reduce((total, item) => total + item.outputs, 0);
  const availableDestinations = () =>
    destinations().filter(
      (destination) =>
        destination.kind !== "source_adjacent" || destinationCapabilities().saveBesideSource,
    );
  const selectedDestination = () =>
    availableDestinations().find((destination) => destination.id === destinationId());
  const sourceAdjacentConfigured = () =>
    destinations().some((destination) => destination.kind === "source_adjacent");
  const selectedStreamIndexes = () => streamIndexes();
  const automaticTracks = () => streamIndexes().length === 0;
  const hiddenStreamIndexes = () =>
    streamIndexes().filter((index) => !tracks().some((track) => track.index === index));
  const preflightFindings = () => (preflight()?.findings ?? []) as ExportFinding[];
  const blockedFinding = () =>
    preflightFindings().find((finding) => finding.severity === "blocked");
  const exportActive = () => exportJob()?.state === "queued" || exportJob()?.state === "running";
  const planBlocker = () => {
    if (!selected()) return "Choose a video before exporting.";
    if (!exportItemIDs().length) return "Select at least one project item.";
    if (emptyItem()) return "Add or include a segment before creating clips.";
    if (destinationsLoading()) return "Loading configured destinations…";
    if (destinationsError()) return "Destinations could not be loaded.";
    if (!availableDestinations().length) return "No export destination is configured.";
    if (!selectedDestination()) return "Choose an available export destination.";
    if (preflightPending()) return "Checking export requirements…";
    if (blockedFinding()) return blockedFinding()!.message;
    if (preflight()?.allowed === false)
      return "The server blocked this export. Review the export settings.";
    return "";
  };
  const planReady = () => !planBlocker();
  const headingId = props.dialog ? "export-dialog-heading" : "export-heading";
  const setTrack = (track: Track, checked: boolean) => {
    const all = streamIndexes().length ? streamIndexes() : tracks().map((item) => item.index);
    exportFeature.setStreams(
      checked ? [...new Set([...all, track.index])] : all.filter((index) => index !== track.index),
    );
  };

  return (
    <section
      class="export-panel"
      classList={{ "export-dialog-content": Boolean(props.dialog) }}
      aria-labelledby={headingId}
    >
      <header class="export-heading-row export-page-heading">
        <div>
          <h2 id={headingId}>{props.dialog ? "Export clips" : "Export"}</h2>
          <p>Turn the saved cut list into verified MKV artifacts.</p>
        </div>
        <Show when={props.onClose}>
          <button class="btn btn-ghost btn-sm" type="button" onClick={props.onClose}>
            Close
          </button>
        </Show>
      </header>

      <Show when={exportStatus()}>
        <div
          class={`export-status ${exportActive() ? "is-active" : ""}`}
          role="status"
          aria-live="polite"
          aria-busy={exportPending() || exportActive()}
        >
          <Show when={exportPending() || exportActive()}>
            <LoaderCircle class="spin" size={17} aria-hidden="true" />
          </Show>
          <span>{exportStatus()}</span>
          <Show when={exportJobLoading()}>
            <span class="export-muted-note">Updating job status…</span>
          </Show>
        </div>
      </Show>

      <Show when={workspace.selected()} fallback={<EmptyExportState />}>
        <div class="export-plan" aria-label="Export plan">
          <div class="export-plan-heading">
            <div>
              <h3>Export plan</h3>
              <p>Review the scope and expected artifacts before queueing work.</p>
            </div>
            <FileOutput size={20} aria-hidden="true" />
          </div>
          <dl>
            <dt>Scope</dt>
            <dd>{scopeLabel()}</dd>
            <dt>{exportSelection() === "segments" ? "Included cuts" : "Requested ranges"}</dt>
            <dd>
              {exportSelection() === "segments" ? includedCount() : requestedRanges()} ·{" "}
              {formatTime(totalDuration(), Math.max(totalDuration(), 1))} requested
            </dd>
            <dt>Arrangement</dt>
            <dd>{exportMode() === "merge" ? "One clip per media item" : "One clip per cut"}</dd>
            <dt>Destination</dt>
            <dd>{selectedDestination()?.label ?? (destinationId() || "Not selected")}</dd>
            <dt>Expected outputs</dt>
            <dd>{expectedOutputs()}</dd>
          </dl>
          <Show when={exportSelection() === "segments" && excludedCount() > 0}>
            <p class="export-muted-note">
              {excludedCount()} excluded cut{excludedCount() === 1 ? "" : "s"} stay in the project
              and will not enter this export.
            </p>
          </Show>
          <div class="export-filename-preview">
            <div class="export-subheading">
              <strong>Filename preview</strong>
              <code>{filenameTemplate() || "{source}-{segment}.{ext}"}</code>
            </div>
            <Show
              when={summary().some((item) => item.filenamePreviews.length > 0)}
              fallback={<p class="export-muted-note">Add a range to preview its output name.</p>}
            >
              <ul aria-label="Filename previews">
                <For each={summary()}>
                  {(item) => (
                    <For each={item.filenamePreviews}>
                      {(filename) => (
                        <li>
                          <code>{filename}</code>
                        </li>
                      )}
                    </For>
                  )}
                </For>
              </ul>
            </Show>
            <p class="export-muted-note">
              The server sanitizes names and adds collision-safe suffixes.
            </p>
          </div>
        </div>

        <Show when={destinationsError()}>
          {(message) => (
            <div class="alert alert-error alert-soft" role="alert">
              <CircleAlert size={16} aria-hidden="true" />
              <span>{message()}</span>
              <button class="btn btn-ghost btn-xs" type="button" onClick={retryDestinations}>
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </button>
            </div>
          )}
        </Show>
        <Show when={destinationsLoading() && !destinations().length}>
          <div class="export-loading" role="status" aria-busy="true">
            <LoaderCircle class="spin" size={16} aria-hidden="true" /> Loading destinations…
          </div>
        </Show>
        <Show when={preflightError()}>
          {(message) => (
            <div class="alert alert-error alert-soft" role="alert">
              <CircleAlert size={16} aria-hidden="true" /> <span>{message()}</span>
            </div>
          )}
        </Show>
        <Show when={preflightPending()}>
          <div class="export-loading" role="status" aria-busy="true">
            <LoaderCircle class="spin" size={16} aria-hidden="true" /> Checking export requirements…
          </div>
        </Show>

        <Show when={preflight() || preflightPending()}>
          <section class="export-preflight" aria-labelledby="export-preflight-heading">
            <div class="export-section-heading">
              <div>
                <h3 id="export-preflight-heading">Server preflight</h3>
                <p>These are the backend’s current stream and publication checks.</p>
              </div>
              <Show when={preflight()}>
                <span
                  class={`badge badge-sm ${preflight()!.allowed ? "badge-success" : "badge-error"}`}
                >
                  {preflight()!.allowed ? "allowed" : "blocked"}
                </span>
              </Show>
            </div>
            <Show when={preflight()?.selection.length}>
              <div class="export-resolved-selection">
                <strong>Resolved streams</strong>
                <span>
                  {preflight()!
                    .selection.map((index) => {
                      const track = tracks().find((item) => item.index === index);
                      return track ? trackLabel(track) : `Stream ${index}`;
                    })
                    .join(", ")}
                </span>
              </div>
            </Show>
            <Show
              when={preflightFindings().length > 0}
              fallback={
                <p class="export-muted-note">
                  {preflightPending()
                    ? "Waiting for the server response…"
                    : "No additional findings."}
                </p>
              }
            >
              <div class="export-findings" aria-label="Export preflight findings">
                <For each={preflightFindings()}>
                  {(finding) => (
                    <div
                      role={finding.severity === "blocked" ? "alert" : "status"}
                      class={`alert alert-soft export-finding export-finding-${finding.severity}`}
                    >
                      <FindingIcon severity={finding.severity} />
                      <div>
                        <strong>{findingTitle[finding.severity]}</strong>
                        <span>{finding.message}</span>
                        <small>
                          {finding.code}
                          <Show when={finding.streamIndex !== undefined}>
                            {` · stream ${finding.streamIndex}`}
                          </Show>
                        </small>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </section>
        </Show>

        <fieldset class="export-items" aria-label="Export scope">
          <legend>Export scope</legend>
          <div class="export-section-heading">
            <div>
              <h3>Choose what enters this batch</h3>
              <p>Scope is evaluated against the project revision saved before queueing.</p>
            </div>
          </div>
          <Show
            when={projectItems().length > 1}
            fallback={<p class="export-muted-note">Active media item: {scopeLabel()}</p>}
          >
            <div class="export-scope-modes" role="radiogroup" aria-label="Export scope mode">
              <label>
                <input
                  class="radio radio-sm"
                  type="radio"
                  name="export-scope-mode"
                  value="active"
                  checked={exportScope() === "active"}
                  onChange={() => setExportScope("active")}
                />
                <span>
                  <strong>Active media item</strong>
                  <small>Export only {selected()?.name ?? "the current item"}.</small>
                </span>
              </label>
              <label>
                <input
                  class="radio radio-sm"
                  type="radio"
                  name="export-scope-mode"
                  value="selected"
                  checked={exportScope() === "selected"}
                  onChange={() => setExportScope("selected")}
                />
                <span>
                  <strong>Selected project items</strong>
                  <small>Build one batch from the checked project items.</small>
                </span>
              </label>
            </div>
            <Show
              when={exportScope() === "selected"}
              fallback={
                <p class="export-muted-note">
                  Only the active media item enters this export. Choose selected project items to
                  include more than the active media.
                </p>
              }
            >
              <div class="export-item-checklist" aria-label="Project items to export">
                <For each={projectItems()}>
                  {(item) => (
                    <label>
                      <input
                        class="checkbox checkbox-sm"
                        type="checkbox"
                        checked={selectedExportItems().includes(item.id)}
                        onChange={(event) =>
                          setSelectedExportItems((ids) =>
                            event.currentTarget.checked
                              ? [...new Set([...ids, item.id])]
                              : ids.filter((id) => id !== item.id),
                          )
                        }
                      />
                      <span>
                        <strong>{item.media.name}</strong>
                        <small>
                          {item.timeline.present.segments.length} cut
                          {item.timeline.present.segments.length === 1 ? "" : "s"} · {item.id}
                        </small>
                      </span>
                    </label>
                  )}
                </For>
              </div>
              <div class="controls">
                <button
                  class="btn btn-ghost btn-xs"
                  type="button"
                  onClick={() => setSelectedExportItems(projectItems().map((item) => item.id))}
                >
                  Select all
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  type="button"
                  onClick={() => setSelectedExportItems([])}
                >
                  Select none
                </button>
              </div>
            </Show>
          </Show>
        </fieldset>

        <details class="export-options" open>
          <summary>
            <SlidersHorizontal size={15} aria-hidden="true" /> Export options
          </summary>
          <div class="option-fields">
            <label>
              Output arrangement
              <select
                class="select select-bordered select-sm"
                aria-label="Output arrangement"
                value={exportMode()}
                onChange={(event) =>
                  exportFeature.setMode(event.currentTarget.value as "merge" | "separate")
                }
              >
                <option value="merge">Combine selected cuts per media item</option>
                <option value="separate">Export each selected cut separately</option>
              </select>
            </label>
            <label>
              What to export
              <select
                class="select select-bordered select-sm"
                aria-label="What to export"
                value={exportSelection()}
                onChange={(event) =>
                  exportFeature.setSelection(event.currentTarget.value as "segments" | "gaps")
                }
              >
                <option value="segments">Included cuts</option>
                <option value="gaps">Gaps between cuts (whole-file workflow)</option>
              </select>
            </label>
            <Show when={exportSelection() === "gaps"}>
              <p class="control-help">
                Gap exports are an explicit alternate workflow; with no cuts, the whole source is
                requested.
              </p>
            </Show>

            <fieldset class="export-track-fieldset">
              <legend>Tracks</legend>
              <p>
                {automaticTracks()
                  ? "Automatic selection keeps every supported video, audio, and subtitle stream."
                  : "Choose at least one supported stream for this export."}
              </p>
              <Show when={!automaticTracks()}>
                <button
                  class="btn btn-ghost btn-xs"
                  type="button"
                  onClick={() => exportFeature.setStreams([])}
                >
                  Reset to automatic tracks
                </button>
              </Show>
              <Show
                when={tracks().length > 0}
                fallback={
                  <p class="export-muted-note">
                    No supported stream metadata is available for this media item.
                  </p>
                }
              >
                <div class="export-track-list">
                  <For each={tracks()}>
                    {(track) => {
                      const checked = () =>
                        automaticTracks() || streamIndexes().includes(track.index);
                      return (
                        <label class="stream-row">
                          <input
                            class="checkbox checkbox-sm"
                            type="checkbox"
                            aria-label={trackLabel(track)}
                            checked={checked()}
                            disabled={
                              checked() && (streamIndexes().length || tracks().length) === 1
                            }
                            onChange={(event) => setTrack(track, event.currentTarget.checked)}
                          />
                          <span>
                            <strong>{trackLabel(track)}</strong>
                            <small>
                              stream {track.index} · {trackDetails(track)}
                            </small>
                          </span>
                        </label>
                      );
                    }}
                  </For>
                </div>
              </Show>
              <Show when={hiddenStreamIndexes().length > 0}>
                <div class="alert alert-warning alert-soft" role="alert">
                  <CircleAlert size={15} aria-hidden="true" />
                  <span>
                    Saved stream selection includes unavailable stream
                    {hiddenStreamIndexes().length === 1 ? "" : "s"}{" "}
                    {hiddenStreamIndexes().join(", ")}. Server preflight will block this export
                    until the selection is corrected.
                  </span>
                </div>
              </Show>
              <Show when={preflight()?.selection.length && automaticTracks()}>
                <p class="control-help">
                  Server resolved streams: {preflight()!.selection.join(", ")}.
                </p>
              </Show>
              <Show when={selectedStreamIndexes().length > 0}>
                <p class="control-help">Explicit streams: {selectedStreamIndexes().join(", ")}.</p>
              </Show>
            </fieldset>

            <label>
              Processing
              <select
                class="select select-bordered select-sm"
                aria-label="Processing"
                value={cutStrategy()}
                onChange={(event) =>
                  exportFeature.setStrategy(
                    event.currentTarget.value as Parameters<typeof exportFeature.setStrategy>[0],
                  )
                }
              >
                <option value="stream_copy_preferred">Fast copy</option>
                <option value="precise_reencode">Precise encode</option>
                <option
                  value="hybrid_smart_cut"
                  disabled={hybridSmartCutKnownIneligible(selected())}
                >
                  Hybrid smart cut
                  {hybridSmartCutKnownIneligible(selected()) ? " (unavailable)" : ""}
                </option>
              </select>
            </label>
            <Show when={cutStrategy() === "stream_copy_preferred"}>
              <p class="control-help">
                Fast copy avoids re-encoding, but boundaries may move to nearby keyframes and are
                not frame-exact.
              </p>
            </Show>
            <Show when={cutStrategy() === "precise_reencode"}>
              <p class="control-help">
                Precise encode re-encodes the selected ranges. The server marks these outputs for
                review because codec behavior still needs inspection.
              </p>
            </Show>
            <Show when={cutStrategy() === "hybrid_smart_cut"}>
              <p class="control-help">
                Hybrid smart cut is limited to compatible H.264 constant-frame-rate MKV sources; the
                server reports any stream-copy fallback per cut.
              </p>
            </Show>

            <div class="export-destination-field">
              <label>
                Destination
                <Show when={!destinationsLoading() && availableDestinations().length > 0}>
                  <select
                    class="select select-bordered select-sm"
                    aria-label="Destination"
                    value={destinationId()}
                    onChange={(event) => exportFeature.setDestination(event.currentTarget.value)}
                  >
                    <For each={availableDestinations()}>
                      {(destination) => <option value={destination.id}>{destination.label}</option>}
                    </For>
                  </select>
                </Show>
              </label>
              <Show when={selectedDestination()}>
                {(destination) => (
                  <div class="destination-description">
                    <div>
                      <strong>{destination().label}</strong>
                      <span>
                        {destination().description || "No destination description provided."}
                      </span>
                    </div>
                    <dl>
                      <dt>Type</dt>
                      <dd>{destinationTypeLabel(destination().kind)}</dd>
                      <dt>Retention</dt>
                      <dd>{destination().retention || "Durable"}</dd>
                    </dl>
                  </div>
                )}
              </Show>
              <Show
                when={sourceAdjacentConfigured() && !destinationCapabilities().saveBesideSource}
              >
                <p class="control-help">
                  Saving beside the source is configured but unavailable in this deployment; the
                  server intentionally withholds that destination.
                </p>
              </Show>
              <Show when={destinationId() === "download"}>
                <p class="control-help">
                  Browser downloads use authenticated output actions after completion.
                </p>
              </Show>
            </div>

            <details class="export-naming-details">
              <summary>Advanced naming</summary>
              <label>
                Filename template
                <input
                  class="input input-bordered input-sm"
                  maxLength={160}
                  value={filenameTemplate()}
                  onInput={(event) => exportFeature.setTemplate(event.currentTarget.value)}
                />
              </label>
              <p class="control-help">
                Tokens: <code>{"{source}"}</code>, <code>{"{date}"}</code>, <code>{"{time}"}</code>,{" "}
                <code>{"{segment}"}</code>, <code>{"{mode}"}</code>, <code>{"{ext}"}</code>. The
                server rejects unknown or malformed tokens.
              </p>
            </details>
          </div>
        </details>

        <div class="export-submit-row">
          <div>
            <strong>{planReady() ? "Ready to queue" : "Resolve before queueing"}</strong>
            <span>
              {expectedOutputs()} expected output{expectedOutputs() === 1 ? "" : "s"} · MKV only
            </span>
            <Show when={planBlocker()}>
              <p role="status">{planBlocker()}</p>
            </Show>
          </div>
          <div class="controls">
            <button
              class="btn btn-primary"
              type="button"
              disabled={!planReady() || exportPending() || exportActive()}
              onClick={() => void exportProject()}
            >
              <Download size={16} aria-hidden="true" /> Create clips
            </button>
            <Show when={exportActive()}>
              <button class="btn btn-ghost" type="button" onClick={() => void cancelExport()}>
                Cancel export
              </button>
            </Show>
          </div>
        </div>

        <Show when={destinationStatus()}>
          {(message) => (
            <p class="export-muted-note" role="status">
              {message()}
            </p>
          )}
        </Show>

        <Show when={batchId()}>
          <section class="export-activity" aria-labelledby="export-activity-heading">
            <div class="export-section-heading">
              <div>
                <h3 id="export-activity-heading">Current batch</h3>
                <p>
                  Batch <code>{batchId()}</code> · saved project revision {exportRevision() ?? "—"}
                </p>
              </div>
              <Show when={batchLoading()}>
                <LoaderCircle class="spin" size={16} aria-label="Updating batch" />
              </Show>
            </div>
            <Show when={batchError()}>
              {(message) => (
                <div class="alert alert-error alert-soft" role="alert">
                  <CircleAlert size={16} aria-hidden="true" />
                  <span>{message()}</span>
                </div>
              )}
            </Show>
            <Show
              when={batchJobs().length > 0}
              fallback={<p class="export-muted-note">Waiting for job details…</p>}
            >
              <For each={batchJobs()}>
                {(job, index) => (
                  <ExportJobCard
                    job={job}
                    ordinal={index() + 1}
                    batchId={batchId()}
                    destinations={destinations}
                    canDownloadBatch={batchJobs().every(
                      (item) =>
                        item.state === "succeeded" && item.result?.destinationKind === "download",
                    )}
                    onCancel={workspace.cancelChildJob}
                    onRetry={workspace.retryChildJob}
                  />
                )}
              </For>
            </Show>
            <Show when={exportJobError()}>
              {(message) => (
                <p class="control-help" role="alert">
                  {message()}
                </p>
              )}
            </Show>
          </section>
        </Show>
      </Show>

      <QueueView />
    </section>
  );
}

function EmptyExportState() {
  return (
    <div class="export-empty-state" role="status">
      <Archive size={20} aria-hidden="true" />
      <div>
        <strong>Choose media to build an export</strong>
        <p>The export plan appears after a media item is active in the project.</p>
      </div>
    </div>
  );
}
