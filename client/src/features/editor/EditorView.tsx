import { createEffect, createSignal, Show } from "solid-js";
import { Clock3, LocateFixed, Maximize2, Minus, ZoomIn, ZoomOut } from "lucide-solid";
import { Timeline } from "./Timeline";
import { canStreamPreview, formatTime, parseTimecode } from "../preview/model";
import { PreviewPlayer } from "../preview/PreviewPlayer";
import { useWorkspace } from "../app/WorkspaceContext";

export function EditorView(props: { onChooseMedia: () => void }) {
  const workspace = useWorkspace();
  const [boundaryDraft, setBoundaryDraft] = createSignal<Partial<Record<"inMs" | "outMs", string>>>(
    {},
  );
  let boundaryContext = "";
  createEffect(() => {
    const nextContext = `${workspace.selected()?.id ?? ""}:${workspace.activeSegmentIndex() ?? ""}`;
    if (nextContext === boundaryContext) return;
    boundaryContext = nextContext;
    setBoundaryDraft({});
  });
  const boundaryValue = (kind: "inMs" | "outMs") => {
    const draft = boundaryDraft()[kind];
    if (draft !== undefined) return draft;
    const value = kind === "inMs" ? workspace.editingInMs() : workspace.editingOutMs();
    return value === undefined ? "" : formatTime(value, workspace.duration());
  };
  const confirmTimecode = (input: HTMLInputElement) => {
    const value = parseTimecode(input.value);
    if (value === undefined || value > workspace.duration()) {
      workspace.setEditorStatus("Enter a valid timecode within this video.");
      return;
    }
    workspace.setTimecode("");
    workspace.updateTimeline({ playheadMs: value });
    input.blur();
  };
  const confirmBoundary = (kind: "inMs" | "outMs", input: HTMLInputElement) => {
    const value = parseTimecode(input.value);
    const other = kind === "inMs" ? workspace.editingOutMs() : workspace.editingInMs();
    const validOrder =
      value !== undefined &&
      (other === undefined || (kind === "inMs" ? value < other : value > other));
    if (value === undefined || value > workspace.duration() || !validOrder) {
      workspace.setEditorStatus("In must be before Out and both must be within the video.");
      return;
    }
    workspace.setEditorStatus("");
    workspace.setMarker(kind, value);
    if (!workspace.editorStatus())
      setBoundaryDraft((current) => ({ ...current, [kind]: undefined }));
  };
  const validRange = () => {
    const inMs = workspace.editingInMs();
    const outMs = workspace.editingOutMs();
    return inMs !== undefined && outMs !== undefined && inMs < outMs;
  };
  const guidance = () => {
    const inMs = workspace.editingInMs();
    const outMs = workspace.editingOutMs();
    if (workspace.editingActive())
      return `Editing cut ${workspace.activeSegmentIndex()! + 1}. Escape returns to a new draft.`;
    if (inMs === undefined) return "Set an In point to begin a cut.";
    if (outMs === undefined) return "Set an Out point to finish the range.";
    if (inMs >= outMs) return "Move Out after In to create a valid cut.";
    return `Pending cut duration ${formatTime(outMs - inMs, workspace.duration())}.`;
  };
  const keyframeAvailability = () => {
    const video = workspace.selected()?.streams.video as { keyframes?: unknown } | undefined;
    return Array.isArray(video?.keyframes) &&
      video.keyframes.some((value) => Number.isFinite(value))
      ? "available"
      : "unavailable";
  };

  return (
    <section class="editor-panel" aria-labelledby="timeline-heading">
      <div class="panel-heading">
        <h2 id="timeline-heading" tabIndex={-1} class="text-base">
          Timeline
        </h2>
      </div>
      <Show
        when={workspace.selected()}
        fallback={
          <section class="editor-onboarding" aria-labelledby="editor-onboarding-heading">
            <h3 id="editor-onboarding-heading">Choose a video to begin</h3>
            <p>Select a video from the Media library to unlock the editing workspace.</p>
            <button class="btn btn-primary" type="button" onClick={props.onChooseMedia}>
              Choose a video
            </button>
          </section>
        }
      >
        {(item) => (
          <>
            <div class="selected-media-summary" aria-label="Selected media">
              <strong>{item().name}</strong>
              <span>{formatTime(item().durationMs, workspace.duration())}</span>
            </div>
            <Show when={!workspace.activeItemId()}>
              <div class="preview-only-notice" role="status">
                <p class="text-sm text-base-content/70">
                  Preview only · Your first valid cut adds this video to the project.
                </p>
                <button
                  class="btn btn-primary btn-sm"
                  type="button"
                  onClick={() => workspace.addMediaToProject()}
                >
                  Add to project
                </button>
              </div>
            </Show>
            <p id="timeline-description" class="sr-only">
              Playhead {formatTime(workspace.playheadMs(), workspace.duration())}. In marker{" "}
              {workspace.editingInMs() === undefined
                ? "unset"
                : formatTime(workspace.editingInMs()!, workspace.duration())}
              . Out marker{" "}
              {workspace.editingOutMs() === undefined
                ? "unset"
                : formatTime(workspace.editingOutMs()!, workspace.duration())}
              .{" "}
              {workspace.present().segments.length
                ? `${workspace.present().segments.length} cuts selected.`
                : "No cuts selected."}
            </p>
            <Show when={workspace.assetStatus()}>
              {(message) => (
                <div class="alert alert-info mb-2" role="status">
                  <span>{message()}</span>
                  <button
                    class="btn btn-ghost btn-xs"
                    type="button"
                    onClick={workspace.retryAssets}
                  >
                    Retry assets
                  </button>
                </div>
              )}
            </Show>
            <PreviewPlayer
              timeline={<Timeline />}
              controls={
                <div class="editor-controls items-center gap-3">
                  <label class="input input-sm primary-timecode">
                    <Clock3 size={16} aria-hidden="true" />
                    <span class="sr-only">Current timecode</span>
                    <input
                      aria-label="Timecode"
                      value={
                        workspace.timecode() ||
                        formatTime(workspace.playheadMs(), workspace.duration())
                      }
                      onFocus={(event) => {
                        workspace.setTimecode(
                          formatTime(workspace.playheadMs(), workspace.duration()),
                        );
                        event.currentTarget.select();
                      }}
                      onInput={(event) => workspace.setTimecode(event.currentTarget.value)}
                      onBlur={() => workspace.setTimecode("")}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          workspace.setTimecode("");
                          event.currentTarget.blur();
                        } else if (event.key === "Enter") confirmTimecode(event.currentTarget);
                      }}
                    />
                  </label>
                  <span class="total-duration" aria-label="Total duration">
                    / {formatTime(workspace.duration(), workspace.duration())}
                  </span>
                  <div
                    class="control-group marking-controls flex flex-wrap items-center gap-2"
                    aria-label="Cutting"
                  >
                    <label class="marker-value">
                      In:{" "}
                      <input
                        class="input input-sm"
                        aria-label="In point"
                        aria-invalid={Boolean(workspace.editorStatus())}
                        placeholder="Unset"
                        value={boundaryValue("inMs")}
                        onInput={(event) =>
                          setBoundaryDraft((current) => ({
                            ...current,
                            inMs: event.currentTarget.value,
                          }))
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") confirmBoundary("inMs", event.currentTarget);
                          if (event.key === "Escape") {
                            setBoundaryDraft((current) => ({ ...current, inMs: undefined }));
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    </label>
                    <button
                      class="btn btn-sm"
                      aria-label="Set in"
                      aria-keyshortcuts="I"
                      onClick={() => {
                        setBoundaryDraft({});
                        workspace.setMarker("inMs", workspace.watchedPosition());
                      }}
                    >
                      <LocateFixed size={16} aria-hidden="true" /> Set in{" "}
                      <kbd class="kbd kbd-xs" aria-hidden="true">
                        I
                      </kbd>
                    </button>
                    <label class="marker-value">
                      Out:{" "}
                      <input
                        class="input input-sm"
                        aria-label="Out point"
                        aria-invalid={Boolean(workspace.editorStatus())}
                        placeholder="Unset"
                        value={boundaryValue("outMs")}
                        onInput={(event) =>
                          setBoundaryDraft((current) => ({
                            ...current,
                            outMs: event.currentTarget.value,
                          }))
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") confirmBoundary("outMs", event.currentTarget);
                          if (event.key === "Escape") {
                            setBoundaryDraft((current) => ({ ...current, outMs: undefined }));
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    </label>
                    <button
                      class="btn btn-sm"
                      aria-label="Set out"
                      aria-keyshortcuts="O"
                      onClick={() => {
                        setBoundaryDraft({});
                        workspace.setMarker(
                          "outMs",
                          Math.min(workspace.duration(), workspace.watchedPosition()),
                        );
                      }}
                    >
                      <LocateFixed size={16} aria-hidden="true" /> Set out{" "}
                      <kbd class="kbd kbd-xs" aria-hidden="true">
                        O
                      </kbd>
                    </button>
                    <span class="pending-duration" aria-label="Pending cut duration">
                      {validRange()
                        ? formatTime(
                            workspace.editingOutMs()! - workspace.editingInMs()!,
                            workspace.duration(),
                          )
                        : "Unset"}
                    </span>
                    <button
                      class="btn btn-sm"
                      type="button"
                      aria-label="New segment"
                      aria-keyshortcuts="Escape"
                      onClick={workspace.newSegment}
                    >
                      New segment{" "}
                      <kbd class="kbd kbd-xs" aria-hidden="true">
                        Esc
                      </kbd>
                    </button>
                  </div>
                  <div
                    class="control-group view-controls flex items-center gap-1"
                    aria-label="View"
                  >
                    <button
                      class="btn btn-sm btn-square"
                      aria-label="Zoom out"
                      onClick={() =>
                        globalThis.dispatchEvent(new CustomEvent("timeline-zoom", { detail: 0.5 }))
                      }
                    >
                      <ZoomOut size={16} />
                    </button>
                    <span aria-label="Timeline zoom level">{workspace.present().zoom}×</span>
                    <button
                      class="btn btn-sm btn-square"
                      aria-label="Zoom in"
                      onClick={() =>
                        globalThis.dispatchEvent(new CustomEvent("timeline-zoom", { detail: 2 }))
                      }
                    >
                      <ZoomIn size={16} />
                    </button>
                    <button
                      class="btn btn-sm"
                      aria-label="Fit timeline"
                      onClick={() => globalThis.dispatchEvent(new Event("timeline-fit"))}
                    >
                      <Minus size={14} /> Fit
                    </button>
                    <button
                      class="btn btn-sm"
                      aria-label="Fit selected segment"
                      disabled={!workspace.activeSegment()}
                      onClick={() => globalThis.dispatchEvent(new Event("timeline-fit-selection"))}
                    >
                      <Minus size={14} /> Fit selected
                    </button>
                    <button
                      class="btn btn-sm"
                      type="button"
                      aria-label={workspace.waveformVisible() ? "Hide waveform" : "Show waveform"}
                      aria-pressed={workspace.waveformVisible()}
                      onClick={() => workspace.setWaveformVisibility(!workspace.waveformVisible())}
                    >
                      {workspace.waveformVisible() ? "Hide waveform" : "Show waveform"}
                    </button>
                    <button
                      class="btn btn-sm btn-square"
                      aria-label="Fullscreen preview"
                      disabled={!canStreamPreview() || !document.fullscreenEnabled}
                      onClick={() => {
                        const video = document.querySelector<HTMLVideoElement>("video");
                        const request = !document.fullscreenElement
                          ? video?.requestFullscreen?.()
                          : document.exitFullscreen?.();
                        void request?.catch(() =>
                          workspace.setEditorStatus(
                            "Fullscreen is unavailable. Check your browser permissions.",
                          ),
                        );
                      }}
                    >
                      <Maximize2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              }
            />
            <p class="asset-capability" role="status" aria-label="Keyframe snapping availability">
              {keyframeAvailability() === "available"
                ? "Keyframe snapping available"
                : "Keyframe snapping unavailable; source timestamps were not provided."}
            </p>
            <Show when={workspace.editorStatus()}>
              <p class="control-help" role="alert">
                {workspace.editorStatus()}
              </p>
            </Show>
            <p class="control-help mt-2" role="status">
              {guidance()}
            </p>
          </>
        )}
      </Show>
    </section>
  );
}
