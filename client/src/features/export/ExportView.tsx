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
    present,
    export: exportFeature,
    duration,
    tracks,
    exportProject,
    cancelExport,
  } = useWorkspace();
  return (
    <Show when={selected()}>
      <section class="export-panel" aria-labelledby="export-heading">
        <h2 id="export-heading">Export</h2>
        <p role="status">{exportStatus() || "Export a saved project."}</p>
        <Show when={batchId()}>
          <details>
            <summary>Export activity</summary>
            <p role="note">Exporting saved project revision {exportRevision()}.</p>
            <ul aria-label="Export batch jobs">
              <For each={batchJobs()}>{(job) => <li>{job.state}</li>}</For>
            </ul>
          </details>
        </Show>
        <details>
          <summary>Advanced export options</summary>
          <label>
            Mode{" "}
            <select
              value={exportMode()}
              onChange={(event) => {
                exportFeature.setMode(event.currentTarget.value as "merge" | "separate");
              }}
            >
              <option value="merge">Merge</option>
              <option value="separate">Separate</option>
            </select>
          </label>
          <label>
            Selection{" "}
            <select
              value={exportSelection()}
              onChange={(event) => {
                exportFeature.setSelection(event.currentTarget.value as "segments" | "gaps");
              }}
            >
              <option value="segments">Segments</option>
              <option value="gaps">Gaps</option>
            </select>
          </label>
          <fieldset>
            <legend>Streams</legend>
            <For each={tracks()}>
              {(track) => {
                const checked = () =>
                  streamIndexes().length === 0 || streamIndexes().includes(track.index);
                return (
                  <label>
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
                );
              }}
            </For>
          </fieldset>
          <label>
            Cut strategy{" "}
            <select
              value={cutStrategy()}
              onChange={(event) => {
                const value = event.currentTarget.value as Parameters<
                  typeof exportFeature.setStrategy
                >[0];
                exportFeature.setStrategy(value);
              }}
            >
              <option value="stream_copy_preferred">Stream copy preferred</option>
              <option value="precise_reencode">Precise re-encode</option>
              <option value="hybrid_smart_cut" disabled={hybridSmartCutKnownIneligible(selected())}>
                Hybrid smart cut
                {hybridSmartCutKnownIneligible(selected()) ? " (unavailable)" : ""}
              </option>
            </select>
          </label>
          <label>
            Destination{" "}
            <select
              value={destinationId()}
              onChange={(event) => {
                exportFeature.setDestination(event.currentTarget.value);
              }}
            >
              <For each={destinations()}>
                {(destination) => (
                  <option value={destination.id}>
                    {destination.label} ({destination.retention ?? "durable"})
                  </option>
                )}
              </For>
            </select>
          </label>
          <label>
            Filename template{" "}
            <input
              value={filenameTemplate()}
              onInput={(event) => {
                const value = event.currentTarget.value;
                exportFeature.setTemplate(value);
              }}
              aria-label="Filename template"
            />
          </label>
          <p role="status">
            Preview:{" "}
            {filenameTemplate()
              .replaceAll("{ext}", "mkv")
              .replaceAll("{segment}", "1")
              .replaceAll("{mode}", exportMode()) || "server default"}
          </p>
        </details>
        <div aria-label="Export review">
          <p>
            Scope: {exportSelection()} · {present().segments.length} segment
            {present().segments.length === 1 ? "" : "s"} ·{" "}
            {formatTime(
              present().segments.reduce(
                (total, segment) => total + segment.endMs - segment.startMs,
                0,
              ),
              duration(),
            )}{" "}
            total
          </p>
          <p>
            Destination:{" "}
            {destinations().find((item) => item.id === destinationId())?.label ?? destinationId()}
          </p>
          <p>
            Filename:{" "}
            {filenameTemplate()
              .replaceAll("{ext}", "mkv")
              .replaceAll("{segment}", "1")
              .replaceAll("{mode}", exportMode()) || "server default"}
          </p>
          <p>
            Review: {exportMode()} {exportSelection()} · {cutStrategy()}
          </p>
          <p>
            Requested segment bounds:{" "}
            {present()
              .segments.map(
                (segment) =>
                  `${formatTime(segment.startMs, duration())}–${formatTime(segment.endMs, duration())}`,
              )
              .join(", ") || "none"}
          </p>
          <p>Selected streams: {preflight()?.selection?.length ?? "default safe streams"}</p>
          <Show when={cutStrategy() === "stream_copy_preferred"}>
            <p>Stream-copy cuts may begin at an earlier keyframe; no frame-exactness is claimed.</p>
          </Show>
          <Show when={cutStrategy() !== "stream_copy_preferred"}>
            <p>Boundary precision depends on the selected strategy and requires human review.</p>
          </Show>
          <For each={preflight()?.findings ?? []}>
            {(finding) => (
              <p role="status">
                {finding.severity}: {finding.message}
              </p>
            )}
          </For>
        </div>
        <fieldset>
          <legend>Project items to export</legend>
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
          <button
            type="button"
            onClick={() => setSelectedExportItems(projectItems().map((item) => item.id))}
          >
            Select all
          </button>{" "}
          <button type="button" onClick={() => setSelectedExportItems([])}>
            Select none
          </button>
        </fieldset>
        <div class="export-blockers" aria-live="polite">
          <Show when={!selected()}>
            <p>Add a video before exporting.</p>
          </Show>
          <Show when={selected() && !projectItems().length}>
            <p>Select at least one project item.</p>
          </Show>
          <Show when={selected() && projectItems().length === 1 && !present().segments.length}>
            <p>Add at least one segment.</p>
          </Show>
          <Show when={selected() && dirty()}>
            <p>Save the project before exporting.</p>
          </Show>
          <Show when={selected() && preflightPending() && !dirty()}>
            <p>Checking export requirements…</p>
          </Show>
          <Show
            when={
              selected() && !preflightPending() && !dirty() && preflight() && !preflight()!.allowed
            }
          >
            <p>
              {preflight()!
                .findings.map((finding) => finding.message)
                .join(" ") || "The source video is unavailable."}
            </p>
          </Show>
        </div>
        <div class="controls">
          <Show when={exportJob()?.state === "queued" || exportJob()?.state === "running"}>
            <p role="status">Export job {exportJob()!.id} is active; wait or cancel it.</p>
          </Show>
          <button
            aria-label="Start export"
            disabled={
              !selected() ||
              dirty() ||
              !selectedExportItems().length ||
              (projectItems().length === 1 && !present().segments.length) ||
              (projectItems().length === 1 && preflightPending() && !dirty()) ||
              (projectItems().length === 1 && !preflight()?.allowed && !dirty())
            }
            onClick={() => void exportProject()}
          >
            Export {selectedExportItems().length} project item
            {selectedExportItems().length === 1 ? "" : "s"}
          </button>
          <Show when={exportJob()?.state === "queued" || exportJob()?.state === "running"}>
            <button onClick={() => void cancelExport()}>Cancel export</button>
          </Show>
        </div>
        <Show when={exportJob()?.result}>
          <div>
            <div aria-label="Export result">
              <p>
                Output ready:{" "}
                {exportJob()!.result!.outputName ?? exportJob()!.result!.outputNames?.join(", ")}
              </p>
              <p>
                Strategy:{" "}
                {exportJob()!.appliedStrategy ??
                  (exportJob()!.result!.appliedStrategies?.length
                    ? "mixed per segment"
                    : (exportJob()!.strategy ?? cutStrategy()))}{" "}
                · {exportJob()!.verified ? "verified output" : "requires inspection"}
              </p>
              <Show when={(exportJob()!.result!.appliedStrategies?.length ?? 0) > 1}>
                <For each={exportJob()!.result!.appliedStrategies}>
                  {(strategy) => (
                    <p>
                      Segment {strategy.segment}
                      {strategy.outputName ? ` (${strategy.outputName})` : ""}: {strategy.strategy}
                    </p>
                  )}
                </For>
              </Show>
              <p>
                {exportJob()!.result!.sizeBytes.toLocaleString()} bytes · retained until{" "}
                {exportJob()!.result!.retainUntil}
              </p>
            </div>
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
            <p role="note">Please review the exported media before delivery.</p>
            <div aria-label="Export warnings">
              <For each={exportJob()!.warnings ?? []}>
                {(warning) => <p role="status">Warning: {warning}</p>}
              </For>
            </div>
          </div>
        </Show>
      </section>
    </Show>
  );
}
