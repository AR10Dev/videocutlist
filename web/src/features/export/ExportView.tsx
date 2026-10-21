import { For, Show } from "solid-js";
import {
  Archive,
  CircleAlert,
  Download,
  LoaderCircle,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-solid";
import { maxFilenameTemplateLength } from "../settings/model";
import { useWorkspace } from "../../app/WorkspaceContext";
import { createExportPlan } from "./plan";
import { Notice } from "../../components/Notice";
import type { ExportContainer } from "../projects/model";

type Track = {
  index: number;
  type: string;
  codec: string;
  language?: string;
  disposition?: string[];
};

const trackTypeLabel = (type: string) =>
  type === "video" ? "Video" : type === "audio" ? "Audio" : "Subtitle";

const trackLabel = (track: Track) => `${trackTypeLabel(track.type)}: ${track.codec}`;

const trackDetails = (track: Track) => {
  const details = [track.language, ...(track.disposition ?? [])].filter(Boolean);
  return details.join(" · ");
};

type ExportViewProps = {
  dialog?: boolean;
  onClose?: () => void;
};

export function ExportView(props: ExportViewProps = {}) {
  const workspace = useWorkspace();
  const { projectItems } = workspace;
  const { tracks } = workspace.editor;
  const {
    selectedExportItems,
    chooseExportItems,
    exportScope,
    chooseExportScope,
    exportItemIDs,
    exportStatus,
    exportPending,
    destinationStatus,
    exportMode,
    exportSelection,
    cutStrategy,
    hybridSmartCutSupported,
    exportContainer,
    streamIndexes,
    destinations,
    destinationId,
    filenameTemplate,
    preflightPending,
    preflightError,
    retryPreflight,
    destinationsLoading,
    destinationsError,
    retryDestinations,
    exportJobLoading,
    exportProject,
    cancelExport,
  } = workspace.export;
  const exportFeature = workspace.export;

  const {
    summary,
    expectedOutputs,
    plannedContainerLabel,
    exportDestinationLabel,
    availableDestinations,
    itemDestinationId,
    automaticTracks,
    hiddenStreamIndexes,
    preflightFindings,
    exportActive,
    planBlocker,
    planReady,
  } = createExportPlan(workspace);
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
        <h2 id={headingId}>{props.dialog ? "Export clips" : "Export"}</h2>
        <Show when={props.onClose}>
          <button class="btn btn-ghost btn-sm" type="button" onClick={props.onClose}>
            Close
          </button>
        </Show>
      </header>

      <Show when={exportStatus()}>
        <Notice variant="info" busy={exportPending() || exportActive()} label="Export status">
          <Show when={exportPending() || exportActive()}>
            <LoaderCircle class="spin" size={17} aria-hidden="true" />
          </Show>
          <span>{exportStatus()}</span>
          <Show when={exportJobLoading()}>
            <LoaderCircle class="spin" size={14} aria-label="Updating job status" />
          </Show>
        </Notice>
      </Show>

      <Show when={workspace.selected()} fallback={<EmptyExportState />}>
        <div
          class="export-plan"
          classList={{ hidden: projectItems().length === 0 }}
          aria-label="Export plan"
        >
          <p>
            {expectedOutputs()} {expectedOutputs() === 1 ? "clip" : "clips"} ·{" "}
            {plannedContainerLabel()} · {exportDestinationLabel()}
          </p>
        </div>

        <Show when={destinationsError()}>
          {(message) => (
            <Notice variant="error">
              <CircleAlert size={16} aria-hidden="true" />
              <span>{message()}</span>
              <button class="btn btn-ghost btn-xs" type="button" onClick={retryDestinations}>
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </button>
            </Notice>
          )}
        </Show>
        <Show when={destinationsLoading() && !destinations().length}>
          <Notice variant="info" busy>
            <LoaderCircle class="spin" size={16} aria-hidden="true" /> Loading destinations…
          </Notice>
        </Show>
        <Show when={preflightError()}>
          {(message) => (
            <Notice variant="error">
              <CircleAlert size={16} aria-hidden="true" /> <span>{message()}</span>
              <button class="btn btn-ghost btn-xs" type="button" onClick={retryPreflight}>
                <RefreshCw size={14} aria-hidden="true" /> Retry export checks
              </button>
            </Notice>
          )}
        </Show>
        <Show when={preflightPending()}>
          <Notice variant="info" busy>
            <LoaderCircle class="spin" size={16} aria-hidden="true" /> Checking export requirements…
          </Notice>
        </Show>

        <For each={preflightFindings()}>
          {(finding) => (
            <Notice variant={finding.severity === "blocked" ? "error" : "warning"}>
              {finding.message}
            </Notice>
          )}
        </For>

        <Show when={projectItems().length > 1}>
          <fieldset class="export-items" aria-label="Export scope">
            <legend>Export</legend>
            <div class="export-scope-modes" role="radiogroup" aria-label="Export scope mode">
              <label>
                <input
                  class="radio radio-sm"
                  type="radio"
                  name="export-scope-mode"
                  value="active"
                  checked={exportScope() === "active"}
                  onChange={() => chooseExportScope("active")}
                />
                <span>This video</span>
              </label>
              <label>
                <input
                  class="radio radio-sm"
                  type="radio"
                  name="export-scope-mode"
                  value="selected"
                  checked={exportScope() === "selected"}
                  onChange={() => chooseExportScope("selected")}
                />
                <span>Selected videos</span>
              </label>
            </div>
            <Show when={exportScope() === "selected"} fallback={null}>
              <ul class="list export-item-checklist" aria-label="Project items to export">
                <For each={projectItems()}>
                  {(item, index) => (
                    <li class="list-row export-item-row">
                      <label class="export-item-choice">
                        <input
                          class="checkbox checkbox-sm"
                          type="checkbox"
                          checked={selectedExportItems().includes(item.id)}
                          onChange={(event) =>
                            chooseExportItems((ids) =>
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
                            {item.timeline.present.segments.length === 1 ? "" : "s"}
                          </small>
                        </span>
                      </label>
                      <label class="export-item-destination">
                        <span>Destination</span>
                        <select
                          class="select select-sm w-full min-w-0"
                          aria-label={`Destination for ${item.media.name} clip ${index() + 1}`}
                          value={itemDestinationId(item.id)}
                          onChange={(event) =>
                            exportFeature.setItemDestination(item.id, event.currentTarget.value)
                          }
                        >
                          <For each={availableDestinations()}>
                            {(destination) => (
                              <option value={destination.id}>{destination.label}</option>
                            )}
                          </For>
                        </select>
                      </label>
                    </li>
                  )}
                </For>
              </ul>
              <div class="controls">
                <button
                  class="btn btn-ghost btn-xs"
                  type="button"
                  onClick={() => chooseExportItems(projectItems().map((item) => item.id))}
                >
                  Select all
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  type="button"
                  onClick={() => chooseExportItems([])}
                >
                  Select none
                </button>
              </div>
            </Show>
          </fieldset>
        </Show>

        <div class="option-fields">
          <label>
            Output container
            <select
              class="select select-sm w-full min-w-0"
              aria-label="Output container"
              value={exportContainer()}
              onChange={(event) =>
                exportFeature.setContainer(event.currentTarget.value as ExportContainer)
              }
            >
              <option value="mkv">MKV (default)</option>
              <option value="mp4">MP4</option>
              <option value="mov">MOV</option>
            </select>
          </label>
          <label>
            Processing
            <select
              class="select select-sm w-full min-w-0"
              aria-label="Processing"
              value={cutStrategy()}
              onChange={(event) =>
                exportFeature.setStrategy(
                  event.currentTarget.value as Parameters<typeof exportFeature.setStrategy>[0],
                )
              }
            >
              <option
                value="stream_copy_preferred"
                title="Fastest; non-keyframe cuts are not frame-exact."
              >
                Fast copy
              </option>
              <option value="precise_reencode" title="Re-encodes for precise cut boundaries.">
                Precise encode
              </option>
              <option
                value="hybrid_smart_cut"
                title="Precise boundaries for compatible H.264 MKV sources."
                disabled={hybridSmartCutSupported() === false}
              >
                Hybrid smart cut
                {hybridSmartCutSupported() === false ? " (unavailable)" : ""}
              </option>
            </select>
          </label>
        </div>
        <details class="export-options">
          <summary>
            <SlidersHorizontal size={15} aria-hidden="true" /> Export options
          </summary>
          <div class="option-fields">
            <label>
              Output arrangement
              <select
                class="select select-sm w-full min-w-0"
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
                class="select select-sm w-full min-w-0"
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

            <details class="export-track-fieldset">
              <summary>Tracks ({automaticTracks() ? "auto" : "custom"})</summary>
              <Show when={!automaticTracks()}>
                <button
                  class="btn btn-ghost btn-xs"
                  type="button"
                  onClick={() => exportFeature.setStreams([])}
                >
                  Use automatic tracks
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
                            <small>{trackDetails(track)}</small>
                          </span>
                        </label>
                      );
                    }}
                  </For>
                </div>
              </Show>
              <Show when={hiddenStreamIndexes().length > 0}>
                <Notice variant="warning">
                  <CircleAlert size={15} aria-hidden="true" />
                  <span>
                    Saved stream selection includes unavailable stream
                    {hiddenStreamIndexes().length === 1 ? "" : "s"}{" "}
                    {hiddenStreamIndexes().join(", ")}. Server preflight will block this export
                    until the selection is corrected.
                  </span>
                </Notice>
              </Show>
            </details>

            <div class="export-destination-field">
              <label>
                {exportScope() === "selected" && exportItemIDs().length > 1
                  ? "Active item destination"
                  : "Destination"}
                <Show when={!destinationsLoading() && availableDestinations().length > 0}>
                  <select
                    class="select select-sm w-full min-w-0"
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
            </div>

            <details class="export-naming-details">
              <summary>Advanced naming</summary>
              <div class="export-filename-preview">
                <div class="export-subheading">
                  <strong>Filename preview</strong>
                  <code>{filenameTemplate() || "{source}-{segment}.{ext}"}</code>
                </div>
                <Show when={summary().some((item) => item.filenamePreviews.length > 0)}>
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
              </div>

              <label>
                Filename template
                <input
                  class="input input-sm w-full min-w-0"
                  maxLength={maxFilenameTemplateLength}
                  value={filenameTemplate()}
                  onInput={(event) => {
                    if (!exportFeature.setTemplate(event.currentTarget.value))
                      event.currentTarget.value = filenameTemplate();
                  }}
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
      </Show>
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
