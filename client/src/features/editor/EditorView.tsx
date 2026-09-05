import { Show } from "solid-js";
import { Clock3, LocateFixed, Maximize2, Minus, Plus, ZoomIn, ZoomOut } from "lucide-solid";
import { Timeline } from "./Timeline";
import { formatTime, parseTimecode } from "../preview/model";
import { PreviewPlayer } from "../preview/PreviewPlayer";
import { useWorkspace } from "../app/WorkspaceContext";

export function EditorView() {
  const workspace = useWorkspace();
  const confirmTimecode = (input: HTMLInputElement) => {
    const value = parseTimecode(input.value);
    if (value === undefined || value > workspace.duration()) {
      workspace.setStatus("Enter a valid timecode within this video.");
      return;
    }
    workspace.setTimecode(formatTime(value, workspace.duration()));
    workspace.updateTimeline({ playheadMs: value });
    input.blur();
  };
  const confirmBoundary = (kind: "inMs" | "outMs", input: HTMLInputElement) => {
    const value = parseTimecode(input.value);
    const other = kind === "inMs" ? workspace.present().outMs : workspace.present().inMs;
    const validOrder = other === undefined || (kind === "inMs" ? value! < other : value! > other);
    if (value === undefined || value > workspace.duration() || !validOrder) {
      workspace.setStatus("In must be before Out and both must be within the video.");
      return;
    }
    workspace.setMarker(kind, value);
  };
  const validRange = () => {
    const { inMs, outMs } = workspace.present();
    return inMs !== undefined && outMs !== undefined && inMs < outMs;
  };
  const guidance = () => {
    const { inMs, outMs } = workspace.present();
    if (inMs === undefined) return "Set an In point to begin a cut.";
    if (outMs === undefined) return "Set an Out point to finish the range.";
    if (inMs >= outMs) return "Move Out after In to create a valid cut.";
    return `Pending cut duration ${formatTime(outMs - inMs, workspace.duration())}.`;
  };

  return (
    <section class="editor-panel card bg-base-200 shadow-sm" aria-labelledby="timeline-heading">
      <div class="panel-heading">
        <h2 id="timeline-heading" tabIndex={-1} class="card-title text-base">
          Timeline
        </h2>
      </div>
      <Show
        when={workspace.selected()}
        fallback={
          <section class="editor-onboarding" aria-labelledby="editor-onboarding-heading">
            <h3 id="editor-onboarding-heading">Choose a video to begin</h3>
            <p>Select a video from the Media library to unlock the editing workspace.</p>
            <button
              class="btn btn-primary"
              type="button"
              onClick={() => document.getElementById("media-heading")?.focus()}
            >
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
            <p id="timeline-description" class="sr-only">
              Playhead {formatTime(workspace.playheadMs(), workspace.duration())}. In marker{" "}
              {workspace.present().inMs === undefined
                ? "unset"
                : formatTime(workspace.present().inMs!, workspace.duration())}
              . Out marker{" "}
              {workspace.present().outMs === undefined
                ? "unset"
                : formatTime(workspace.present().outMs!, workspace.duration())}
              .{" "}
              {workspace.present().segments.length
                ? `${workspace.present().segments.length} cuts selected.`
                : "No cuts selected."}
            </p>
            <Show when={workspace.assetStatus()}>
              {(message) => (
                <div class="alert alert-info mb-2" role="status">
                  {message()}
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
                        aria-label="In point"
                        placeholder="Unset"
                        value={
                          workspace.present().inMs === undefined
                            ? ""
                            : formatTime(workspace.present().inMs!, workspace.duration())
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") confirmBoundary("inMs", event.currentTarget);
                          if (event.key === "Escape") event.currentTarget.blur();
                        }}
                      />
                    </label>
                    <button
                      class="btn btn-sm"
                      aria-keyshortcuts="I"
                      onClick={() => workspace.setMarker("inMs", workspace.watchedPosition())}
                    >
                      <LocateFixed size={16} aria-hidden="true" /> Set in
                    </button>
                    <label class="marker-value">
                      Out:{" "}
                      <input
                        aria-label="Out point"
                        placeholder="Unset"
                        value={
                          workspace.present().outMs === undefined
                            ? ""
                            : formatTime(workspace.present().outMs!, workspace.duration())
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") confirmBoundary("outMs", event.currentTarget);
                          if (event.key === "Escape") event.currentTarget.blur();
                        }}
                      />
                    </label>
                    <button
                      class="btn btn-sm"
                      aria-keyshortcuts="O"
                      onClick={() =>
                        workspace.setMarker(
                          "outMs",
                          Math.min(workspace.duration(), workspace.watchedPosition()),
                        )
                      }
                    >
                      <LocateFixed size={16} aria-hidden="true" /> Set out
                    </button>
                    <span class="pending-duration" aria-label="Pending cut duration">
                      {validRange()
                        ? formatTime(
                            workspace.present().outMs! - workspace.present().inMs!,
                            workspace.duration(),
                          )
                        : "Unset"}
                    </span>
                    <button
                      class="btn btn-sm btn-primary"
                      aria-label="Add cut (Add segment)"
                      aria-keyshortcuts="C"
                      onClick={workspace.addSegment}
                      disabled={!validRange()}
                      aria-describedby="add-segment-help"
                    >
                      <Plus size={16} aria-hidden="true" /> Add cut
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
                      class="btn btn-sm btn-square"
                      aria-label="Fullscreen preview"
                      onClick={() => {
                        const video = document.querySelector<HTMLVideoElement>("video");
                        if (!document.fullscreenElement) void video?.requestFullscreen?.();
                        else void document.exitFullscreen?.();
                      }}
                    >
                      <Maximize2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              }
            />
            <p id="add-segment-help" class="sr-only" role="status">
              {guidance()}
            </p>
          </>
        )}
      </Show>
    </section>
  );
}
