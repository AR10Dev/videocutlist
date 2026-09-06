import { createSignal, For, Show } from "solid-js";
import { formatTime, hybridSmartCutKnownIneligible } from "../preview/model";
import { useWorkspace } from "../app/WorkspaceContext";
import { BatchDownload } from "./BatchDownload";
import { OutputDownload } from "./OutputDownload";
import { summarizeExports } from "./summary";

type ExportViewProps = {
  dialog?: boolean;
  onClose?: () => void;
};

export function ExportView(props: ExportViewProps = {}) {
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
    destinationCapabilities,
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
  const emptyItem = () =>
    exportSelection() === "segments" ? summary().find((item) => item.outputs === 0) : undefined;
  const scopeLabel = () => {
    if (selectedExportItems().length === 1) {
      return (
        projectItems().find((item) => item.id === selectedExportItems()[0])?.media.name ??
        "Selected media item"
      );
    }
    return `${selectedExportItems().length} project items`;
  };
  const includedCount = () => summary().reduce((total, item) => total + item.includedSegments, 0);
  const excludedCount = () => summary().reduce((total, item) => total + item.excludedSegments, 0);
  const blocker = () => {
    if (exportStatus()) return exportStatus();
    if (!selected()) return "Choose a video before exporting.";
    if (!selectedExportItems().length) return "Select at least one project item.";
    if (emptyItem()) return "Add or include a segment before creating clips.";
    if (preflightPending()) return "Checking export requirements…";
    if (preflight() && !preflight()!.allowed) {
      const finding = preflight()!.findings.find((item) => item.severity === "blocked");
      if (finding?.code === "unsupported_stream") return "Review stream options before exporting.";
      return finding?.message || "The source video is unavailable.";
    }
    return "";
  };
  const findings = () =>
    preflight()?.findings.filter((finding) => finding.severity !== "allowed") ?? [];
  const exportActive = () => exportJob()?.state === "queued" || exportJob()?.state === "running";

  const headingId = props.dialog ? "export-dialog-heading" : "export-heading";
  return (
    <section
      class="export-panel"
      classList={{ "export-dialog-content": Boolean(props.dialog) }}
      aria-labelledby={headingId}
    >
      <header class="export-heading-row">
        <h2 id={headingId}>{props.dialog ? "Export clips" : "Export"}</h2>
        <Show when={props.onClose}>
          <button class="btn btn-ghost btn-sm" type="button" onClick={props.onClose}>
            Close
          </button>
        </Show>
      </header>

      <div class="export-summary" aria-label="Export summary">
        <dl>
          <dt>Scope</dt>
          <dd>{scopeLabel()}</dd>
          <dt>{exportSelection() === "segments" ? "Included segments" : "Requested ranges"}</dt>
          <dd>
            {exportSelection() === "segments" ? includedCount() : selectedSegments().length} ·{" "}
            {formatTime(totalDuration(), totalDuration())} requested
          </dd>
          <dt>Arrangement</dt>
          <dd>{exportMode() === "merge" ? "One clip per media item" : "One clip per segment"}</dd>
          <dt>Destination</dt>
          <dd>
            {destinations().find((item) => item.id === destinationId())?.label ??
              (destinationId() || "Not selected")}
          </dd>
          <dt>Expected outputs</dt>
          <dd>{summary().reduce((total, item) => total + item.outputs, 0)}</dd>
        </dl>
        <Show when={exportSelection() === "segments" && excludedCount() > 0}>
          <p class="export-muted-note">
            {excludedCount()} excluded segment{excludedCount() === 1 ? "" : "s"} will stay in the
            project and will not enter this export.
          </p>
        </Show>
        <div class="export-filename-preview">
          <strong>Filename preview</strong>
          <ul aria-label="Filename previews">
            <For each={summary()}>
              {(item) => (
                <For each={item.filenamePreviews.length ? item.filenamePreviews : [item.filename]}>
                  {(filename) => (
                    <li>
                      <code>{filename}</code>
                    </li>
                  )}
                </For>
              )}
            </For>
          </ul>
          <p class="export-muted-note">
            The server sanitizes names and adds collision-safe suffixes.
          </p>
        </div>
      </div>

      <Show when={findings().length > 0}>
        <div class="export-findings" aria-label="Export preflight findings">
          <For each={findings()}>
            {(finding) => (
              <div
                role={finding.severity === "blocked" ? "alert" : "status"}
                class={`alert ${finding.severity === "blocked" ? "alert-error" : "alert-warning"}`}
              >
                {finding.message}
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={projects.saveConflict()}>
        <div class="alert alert-warning" role="alert">
          <span>Another client saved this project. Choose which version to keep before exporting.</span>
          <div class="controls">
            <button
              class="btn btn-sm"
              type="button"
              onClick={() => void projects.reloadRemoteProject()}
            >
              Reload remote project
            </button>
            <button
              class="btn btn-primary btn-sm"
              type="button"
              onClick={() => void projects.saveAsNewProject()}
            >
              Save local work as new project
            </button>
          </div>
        </div>
      </Show>
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
      <fieldset class="export-items" aria-label="Export scope">
        <legend>Export scope</legend>
        <Show
          when={projectItems().length > 1}
          fallback={<p class="export-muted-note">Active media item: {scopeLabel()}</p>}
        >
          <p class="export-muted-note">Choose which saved project items enter this batch.</p>
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
        </Show>
      </fieldset>

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
              class="select select-bordered select-sm mt-1 w-full"
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
                  </div>
                );
              }}
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
              <For
                each={destinations().filter(
                  (destination) =>
                    destination.kind !== "source_adjacent" ||
                    destinationCapabilities().saveBesideSource,
                )}
              >
                {(destination) => <option value={destination.id}>{destination.label}</option>}
              </For>
            </select>
          </label>
          <p>
            <strong>Retention</strong>{" "}
            {destinations().find((destination) => destination.id === destinationId())?.retention ??
              "Durable"}
          </p>
          <Show when={destinationId() === "download"}>
            <p class="control-help">
              Downloads use the authenticated output actions after completion.
            </p>
          </Show>
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
            <For each={batchJobs()}>
              {(job) => (
                <li>
                  {job.mediaLabel ?? job.projectItemId ?? "Media item"} · {job.state}
                  {job.progress !== undefined ? ` · ${Math.round(job.progress * 100)}%` : ""}
                </li>
              )}
            </For>
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
          <Show when={(exportJob()!.result!.outputFailures?.length ?? 0) > 0}>
            <div role="alert">
              Some clips were not saved. Completed outputs are listed above.
              <ul>
                <For each={exportJob()!.result!.outputFailures}>
                  {(failure) => (
                    <li>
                      Segment {failure.segment}: {failure.message}
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
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
