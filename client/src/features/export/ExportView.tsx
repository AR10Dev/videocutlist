import { createSignal, For, Show } from "solid-js";
import { formatTime, hybridSmartCutKnownIneligible } from "../preview/model";
import { useWorkspace } from "../app/WorkspaceContext";
import { BatchDownload } from "./BatchDownload";
import { OutputDownload } from "./OutputDownload";
import { summarizeExports } from "./summary";

export function ExportView() {
  const {
    selected,
    dirty,
    projectItems,
    editableItems,
    selectedExportItems,
    setSelectedExportItems,
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
    destinationId,
    filenameTemplate,
    preflight,
    preflightPending,
    export: exportFeature,
    tracks,
    exportProject,
    cancelExport,
    projects,
    status,
  } = useWorkspace();
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal("");
  const save = async () => {
    if (saving()) return;
    setSaving(true);
    setSaveError("");
    try {
      if (!(await projects.saveProject()))
        setSaveError(status() || "Project could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const summary = () =>
    summarizeExports(editableItems().filter((item) => selectedExportItems().includes(item.id)));
  const selectedSegments = () => summary().flatMap((item) => item.ranges);
  const totalDuration = () => summary().reduce((total, item) => total + item.duration, 0);
  const emptyItem = () => summary().find((item) => item.outputs === 0);
  const blocker = () => {
    if (exportStatus()) return exportStatus();
    if (!selected()) return "Choose a video before exporting.";
    if (!selectedExportItems().length) return "Select at least one project item.";
    const needsSegment = Boolean(emptyItem());
    if (needsSegment) return "Add a segment before creating clips.";
    if (preflightPending()) return "Checking export requirements…";
    if (preflight() && !preflight()!.allowed) {
      const finding = preflight()!.findings[0];
      if (finding?.code === "unsupported_stream") return "Review stream options before exporting.";
      return finding?.message || "The source video is unavailable.";
    }
    return "";
  };
  const exportActive = () => exportJob()?.state === "queued" || exportJob()?.state === "running";

  return (
    <section class="export-panel" aria-labelledby="export-heading">
      <h2 id="export-heading">Export</h2>

      <div class="export-summary" aria-label="Export summary">
        <p>
          {selectedExportItems().length} item{selectedExportItems().length === 1 ? "" : "s"} ·{" "}
          {selectedSegments().length} segment{selectedSegments().length === 1 ? "" : "s"} ·{" "}
          {formatTime(totalDuration(), totalDuration())}
        </p>
        <p>
          <strong>Destination</strong>{" "}
          {destinations().find((item) => item.id === destinationId())?.label ??
            (destinationId() || "Not selected")}
        </p>
        <p>
          <strong>Expected outputs</strong>{" "}
          {summary().reduce((total, item) => total + item.outputs, 0)}
        </p>
        <p>
          <strong>Filename preview</strong>{" "}
          <code>{summary()[0]?.filename ?? "No output selected"}</code>
        </p>
      </div>

      <Show when={blocker()}>
        {(message) => (
          <p class="export-state" role="status">
            {message()}
          </p>
        )}
      </Show>

      <Show when={destinationStatus()}>
        {(message) => (
          <p class="export-state" role="status">
            {message()}
          </p>
        )}
      </Show>

      <Show when={dirty() && selected()}>
        <button class="btn btn-sm" disabled={saving()} onClick={() => void save()}>
          Save project
        </button>
      </Show>
      <Show when={saveError()}>
        <p role="alert">{saveError()}</p>
      </Show>
      <Show when={projectItems().length > 1}>
        <p>
          Each item uses its own saved export options. Select an item in Project to edit its options
          below.
        </p>
        <fieldset class="export-items">
          <legend>Project items</legend>
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
                />{" "}
                {item.media.name}
              </label>
            )}
          </For>
          <div class="controls">
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              onClick={() => setSelectedExportItems(projectItems().map((item) => item.id))}
            >
              Select all
            </button>
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              onClick={() => setSelectedExportItems([])}
            >
              Select none
            </button>
          </div>
        </fieldset>
      </Show>

      <div class="controls export-actions">
        <span class="shortcut-help" aria-label="Create clips shortcut">
          Create clips <kbd class="kbd kbd-xs">E</kbd>
        </span>
        <button
          class="btn btn-primary btn-sm"
          disabled={
            !selected() ||
            !selectedExportItems().length ||
            Boolean(emptyItem()) ||
            exportPending() ||
            exportActive() ||
            preflightPending() ||
            Boolean(preflight() && !preflight()!.allowed)
          }
          onClick={() => void exportProject()}
        >
          Create clips
        </button>
        <Show when={exportActive()}>
          <button class="btn btn-ghost btn-sm" onClick={() => void cancelExport()}>
            Cancel export
          </button>
        </Show>
      </div>

      <details class="export-options">
        <summary>Export options</summary>
        <div class="option-fields">
          <label>
            Output arrangement
            <select
              class="select select-bordered select-sm mt-1 w-full"
              aria-label="Output arrangement (Mode)"
              value={exportMode()}
              onChange={(event) =>
                exportFeature.setMode(event.currentTarget.value as "merge" | "separate")
              }
            >
              <option value="merge">Combine selected cuts</option>
              <option value="separate">Export each selected cut separately</option>
            </select>
          </label>
          <label>
            What to export
            <select
              class="select select-bordered select-sm mt-1 w-full"
              value={exportSelection()}
              onChange={(event) =>
                exportFeature.setSelection(event.currentTarget.value as "segments" | "gaps")
              }
            >
              <option value="segments">Selected cuts</option>
              <option value="gaps">Gaps between cuts</option>
            </select>
          </label>
          <fieldset>
            <legend>Tracks</legend>
            <p>
              Keep at least one track selected. An automatic selection includes all supported
              tracks.
            </p>
            <For each={tracks()}>
              {(track) => {
                const checked = () =>
                  streamIndexes().length === 0 || streamIndexes().includes(track.index);
                return (
                  <div class="stream-option">
                    <label class="stream-row">
                      <input
                        class="checkbox checkbox-sm"
                        type="checkbox"
                        checked={checked()}
                        disabled={checked() && (streamIndexes().length || tracks().length) === 1}
                        onChange={(event) => {
                          const all = streamIndexes().length
                            ? streamIndexes()
                            : tracks().map((item) => item.index);
                          exportFeature.setStreams(
                            event.currentTarget.checked
                              ? [...new Set([...all, track.index])]
                              : all.filter((index) => index !== track.index),
                          );
                        }}
                      />{" "}
                      {track.type === "video"
                        ? "Video"
                        : track.type === "audio"
                          ? "Audio"
                          : "Subtitle"}
                      : {track.codec}
                    </label>
                    <For
                      each={(preflight()?.findings ?? []).filter(
                        (finding) => finding.streamIndex === track.index,
                      )}
                    >
                      {(finding) => <p role="status">{finding.message}</p>}
                    </For>
                  </div>
                );
              }}
            </For>
            <For
              each={(preflight()?.findings ?? []).filter(
                (finding) => finding.streamIndex === undefined,
              )}
            >
              {(finding) => <p role="status">{finding.message}</p>}
            </For>
          </fieldset>
          <label>
            Processing
            <select
              class="select select-bordered select-sm mt-1 w-full"
              value={cutStrategy()}
              onChange={(event) =>
                exportFeature.setStrategy(
                  event.currentTarget.value as Parameters<typeof exportFeature.setStrategy>[0],
                )
              }
            >
              <option value="stream_copy_preferred">Fast copy</option>
              <option value="precise_reencode">Precise encode</option>
              <option value="hybrid_smart_cut" disabled={hybridSmartCutKnownIneligible(selected())}>
                Hybrid smart cut
                {hybridSmartCutKnownIneligible(selected()) ? " (unavailable)" : ""}
              </option>
            </select>
          </label>
          <Show when={cutStrategy() === "stream_copy_preferred"}>
            <p>
              Fast copy avoids re-encoding, but boundaries may move to nearby keyframes and are not
              frame-exact.
            </p>
          </Show>
          <label>
            Destination
            <select
              class="select select-bordered select-sm mt-1 w-full"
              value={destinationId()}
              onChange={(event) => exportFeature.setDestination(event.currentTarget.value)}
            >
              <For each={destinations()}>
                {(destination) => <option value={destination.id}>{destination.label}</option>}
              </For>
            </select>
          </label>
          <p>
            <strong>Retention</strong>{" "}
            {destinations().find((destination) => destination.id === destinationId())?.retention ??
              "Durable"}
          </p>
          <details>
            <summary>Advanced naming</summary>
            <label>
              Filename template
              <input
                class="input input-bordered input-sm mt-1 w-full"
                value={filenameTemplate()}
                onInput={(event) => exportFeature.setTemplate(event.currentTarget.value)}
              />
            </label>
            <p class="control-help">
              Tokens: {"{source}"}, {"{segment}"}, {"{mode}"}, {"{ext}"}
            </p>
          </details>
        </div>
      </details>

      <Show when={batchId()}>
        <details>
          <summary>Export activity</summary>
          <p role="note">Exporting saved project revision {exportRevision()}.</p>
          <ul aria-label="Export batch jobs">
            <For each={batchJobs()}>{(job) => <li>{job.state}</li>}</For>
          </ul>
        </details>
      </Show>

      <Show when={exportJob()?.result}>
        <div class="export-result" aria-label="Export result">
          <p>
            Output ready:{" "}
            {exportJob()!.result!.outputName ?? exportJob()!.result!.outputNames?.join(", ")}
          </p>
          <p>
            {exportJob()!.verified ? "Verified output" : "Review before delivery"} ·{" "}
            {exportJob()!.result!.sizeBytes.toLocaleString()} bytes · retained until{" "}
            {exportJob()!.result!.retainUntil}
          </p>
          <Show
            when={
              exportJob()!.state === "succeeded" &&
              exportJob()!.result!.destinationKind === "download"
            }
          >
            <Show
              when={
                batchId() &&
                (
                  exportJob()!.result!.outputNames ??
                  (exportJob()!.result!.outputName ? [exportJob()!.result!.outputName] : [])
                ).length > 1
              }
            >
              <BatchDownload
                batchId={batchId()!}
                outputCount={
                  (
                    exportJob()!.result!.outputNames ??
                    (exportJob()!.result!.outputName ? [exportJob()!.result!.outputName] : [])
                  ).length
                }
              />
            </Show>
            <For
              each={
                exportJob()!.result!.outputNames ??
                (exportJob()!.result!.outputName ? [exportJob()!.result!.outputName] : [])
              }
            >
              {(name, position) => (
                <OutputDownload
                  jobId={exportJob()!.id}
                  position={position()}
                  name={name ?? `output-${position() + 1}.mkv`}
                />
              )}
            </For>
          </Show>
          <Show
            when={
              exportJob()!.state === "succeeded" &&
              exportJob()!.result!.destinationKind !== undefined &&
              exportJob()!.result!.destinationKind !== "download"
            }
          >
            <p role="status">
              Clips created in{" "}
              {destinations().find((item) => item.id === exportJob()!.result!.destinationId)
                ?.label ?? "the configured server destination"}
              .
            </p>
          </Show>
          <div aria-label="Export warnings">
            <For each={exportJob()!.warnings ?? []}>
              {(warning) => <p role="status">Warning: {warning}</p>}
            </For>
          </div>
        </div>
      </Show>
    </section>
  );
}
