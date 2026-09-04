import { For, Show } from "solid-js";
import { formatTime, hybridSmartCutKnownIneligible } from "../preview/model";
import { useWorkspace } from "../app/WorkspaceContext";
import { createApiClient, resolveBrowserConfiguration } from "../../api";

const api = createApiClient(resolveBrowserConfiguration());

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
    duration,
    tracks,
    exportProject,
    cancelExport,
  } = useWorkspace();

  const outputName = () =>
    filenameTemplate()
      .replaceAll("{ext}", "mkv")
      .replaceAll("{segment}", "1")
      .replaceAll("{mode}", exportMode()) || "Server default";
  const selectedSegments = () =>
    editableItems()
      .filter((item) => selectedExportItems().includes(item.id))
      .flatMap((item) => item.timeline.present.segments);
  const totalDuration = () =>
    selectedSegments().reduce((total, segment) => total + segment.endMs - segment.startMs, 0);
  const blocker = () => {
    if (exportStatus()) return exportStatus();
    if (!selected()) return "Choose a video before exporting.";
    if (!selectedExportItems().length) return "Select at least one project item.";
    const needsSegment = projectItems().length === 1 && !selectedSegments().length;
    if (needsSegment && dirty()) return "Add a segment and save the project before exporting.";
    if (needsSegment) return "Add a segment before exporting.";
    if (dirty()) return "Save the project before exporting.";
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
          {formatTime(totalDuration(), duration())}
        </p>
        <p>
          <strong>Destination</strong>{" "}
          {destinations().find((item) => item.id === destinationId())?.label ??
            (destinationId() || "Not selected")}
        </p>
        <p>
          <strong>Expected outputs</strong>{" "}
          {exportMode() === "merge" ? 1 : Math.max(1, selectedSegments().length)}
        </p>
        <p>
          <strong>Filename preview</strong> <code>{outputName()}</code>
        </p>
      </div>

      <Show when={blocker()}>
        {(message) => (
          <p class="export-state" role="status">
            {message()}
          </p>
        )}
      </Show>

      <Show when={projectItems().length > 1}>
        <fieldset class="export-items">
          <legend>Project items</legend>
          <For each={projectItems()}>
            {(item) => (
              <label>
                <input
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
              type="button"
              onClick={() => setSelectedExportItems(projectItems().map((item) => item.id))}
            >
              Select all
            </button>
            <button type="button" onClick={() => setSelectedExportItems([])}>
              Select none
            </button>
          </div>
        </fieldset>
      </Show>

      <div class="controls export-actions">
        <button
          class="primary"
          disabled={
            !selected() ||
            dirty() ||
            !selectedExportItems().length ||
            (projectItems().length === 1 && !selectedSegments().length) ||
            (projectItems().length === 1 && preflightPending()) ||
            (projectItems().length === 1 && !preflight()?.allowed)
          }
          onClick={() => void exportProject()}
        >
          {selectedExportItems().length === 1
            ? "Export item"
            : `Export ${selectedExportItems().length} items`}
        </button>
        <Show when={exportActive()}>
          <button onClick={() => void cancelExport()}>Cancel export</button>
        </Show>
      </div>

      <details class="export-options">
        <summary>Export options</summary>
        <div class="option-fields">
          <label>
            Output arrangement
            <select
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
            <For each={tracks()}>
              {(track) => {
                const checked = () =>
                  streamIndexes().length === 0 || streamIndexes().includes(track.index);
                return (
                  <div class="stream-option">
                    <label class="stream-row">
                      <input
                        type="checkbox"
                        checked={checked()}
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
                    <For each={(preflight()?.findings ?? []).filter((finding) => finding.streamIndex === track.index)}>
                      {(finding) => <p role="status">{finding.message}</p>}
                    </For>
                  </div>
                );
              }}
            </For>
            <For each={(preflight()?.findings ?? []).filter((finding) => finding.streamIndex === undefined)}>
              {(finding) => <p role="status">{finding.message}</p>}
            </For>
          </fieldset>
          <label>
            Processing
            <select
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
            <For
              each={
                exportJob()!.result!.outputNames ??
                (exportJob()!.result!.outputName ? [exportJob()!.result!.outputName] : [])
              }
            >
              {(_, position) => (
                <a
                  href={api.url(
                    `jobs/${encodeURIComponent(exportJob()!.id)}/outputs/${position()}`,
                  )}
                  download=""
                >
                  Download output {position() + 1}
                </a>
              )}
            </For>
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
