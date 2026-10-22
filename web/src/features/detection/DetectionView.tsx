import { isActiveState, isTerminalState } from "../queue/jobState";
import { createEffect, createSignal, For, Show } from "solid-js";
import {
  CheckCircle2,
  CircleAlert,
  Crosshair,
  LoaderCircle,
  Play,
  ScanLine,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-solid";
import { canStreamPreview, formatTime } from "../preview/model";
import { candidatePointMs, candidateRange, type Candidate, type DetectionKind } from "./model";
import { Notice } from "../../components/Notice";
import { useConfirmation } from "../../components/ConfirmDialog";
import { useWorkspace } from "../../app/WorkspaceContext";

const kindLabel: Record<DetectionKind, string> = {
  silence: "Pauses",
  black: "Black sections",
  scene: "Scene changes",
};

const kindDescription: Record<DetectionKind, string> = {
  silence: "Find quiet ranges to review before removing.",
  black: "Find sustained black ranges in the picture.",
  scene: "Find visual change points without adding segments.",
};

const candidateLabel = (candidate: Candidate, durationMs: number) => {
  const pointMs = candidatePointMs(candidate);
  if (pointMs !== undefined) return `Scene change at ${formatTime(pointMs, durationMs)}`;
  const range = candidateRange(candidate);
  if (!range) return "Invalid candidate";
  return `${formatTime(range.startMs, durationMs)} – ${formatTime(range.endMs, durationMs)}`;
};

export function DetectionView() {
  const workspace = useWorkspace();
  const confirm = useConfirmation();
  const options = workspace.detection.detectionOptions;
  const setOptions = workspace.detection.setDetectionOptions;
  const starting = workspace.detection.detectionStarting;
  const [reviewIndex, setReviewIndex] = createSignal(0);
  let optionsElement: HTMLFieldSetElement | undefined;
  const candidateRows = new Map<string, HTMLLIElement>();

  createEffect(() => {
    const candidates = workspace.detection.detectionCandidates();
    if (!candidates.length) {
      setReviewIndex(0);
    } else if (reviewIndex() >= candidates.length) {
      setReviewIndex(candidates.length - 1);
    }
  });

  const focusCandidate = (candidate: Candidate | undefined) => {
    if (!candidate) return;
    const index = workspace.detection
      .detectionCandidates()
      .findIndex((item) => item.id === candidate.id);
    if (index < 0) return;
    setReviewIndex(index);
    queueMicrotask(() => candidateRows.get(candidate.id)?.focus());
  };
  const focusNextCandidate = (index: number) => {
    const candidates = workspace.detection.detectionCandidates();
    focusCandidate(candidates[Math.min(index, candidates.length - 1)]);
  };
  const accept = (candidate: Candidate) => {
    const index = workspace.detection
      .detectionCandidates()
      .findIndex((item) => item.id === candidate.id);
    const result = workspace.detection.acceptDetection(candidate);
    if (result.accepted.length) focusNextCandidate(index);
  };
  const reject = (candidate: Candidate) => {
    const index = workspace.detection
      .detectionCandidates()
      .findIndex((item) => item.id === candidate.id);
    workspace.detection.rejectDetection(candidate);
    focusNextCandidate(index);
  };
  const preview = (candidate: Candidate, index: number) => {
    setReviewIndex(index);
    const pointMs = candidatePointMs(candidate);
    if (pointMs !== undefined) {
      workspace.detection.setDetectionStatus(`Previewing scene change ${index + 1}.`);
      workspace.preview.playDetectionPoint(pointMs);
      return;
    }
    const range = candidateRange(candidate);
    if (!range) {
      workspace.detection.setDetectionStatus("That candidate has invalid playback bounds.");
      return;
    }
    workspace.detection.setDetectionStatus(`Previewing candidate ${index + 1}.`);
    workspace.preview.playSegment({
      ...range,
      label: candidate.source,
      included: true,
    });
  };
  const seek = (candidate: Candidate) => {
    const pointMs = candidatePointMs(candidate);
    if (pointMs === undefined) return;
    workspace.preview.seekDetectionPoint(pointMs);
    workspace.detection.setDetectionStatus("Scene change selected; dismiss it or keep reviewing.");
  };
  const updateOption = (key: "noiseDb" | "minDurationMs" | "sceneThreshold", value: string) => {
    setOptions((current) => ({
      ...current,
      [key]: value === "" ? undefined : Number(value),
    }));
  };
  const start = (kind: DetectionKind) => {
    if (starting()) return;
    const invalid = optionsElement?.querySelector<HTMLInputElement>("input:invalid");
    if (invalid) {
      const details = optionsElement?.closest("details");
      if (details) details.open = true;
      invalid.reportValidity();
      return;
    }
    workspace.detection.startDetection(kind);
  };
  const active = () =>
    starting() ||
    workspace.detection.detectionLoading() ||
    isActiveState(workspace.detection.detectionJob()?.state);
  const canStart = () => Boolean(workspace.selected() && workspace.activeItemId()) && !active();
  const acceptAll = async () => {
    const candidates = workspace.detection.detectionCandidates();
    if (!candidates.length) return;
    if (
      !(await confirm({
        title: `Accept all ${candidates.length} candidates?`,
        message: "Stale, invalid, and overlapping candidates will be skipped.",
        action: "Accept all valid",
      }))
    )
      return;
    if (candidates !== workspace.detection.detectionCandidates()) return;
    const result = workspace.detection.bulkAcceptDetection();
    if (result.accepted.length) focusCandidate(workspace.detection.detectionCandidates()[0]);
  };
  const handleReviewKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (
      event.defaultPrevented ||
      target.closest(
        "input, textarea, select, [contenteditable='true'], [role='combobox'], [role='dialog'], dialog",
      )
    )
      return;
    const candidate = workspace.detection.detectionCandidates()[reviewIndex()];
    if (!candidate) return;
    const key = event.key.toLowerCase();
    const enterOnRow = key === "enter" && !target.closest("button, a");
    if (key === "a" || key === "y" || enterOnRow) {
      event.preventDefault();
      accept(candidate);
    } else if (
      key === "r" ||
      key === "x" ||
      key === "n" ||
      event.key === "Delete" ||
      event.key === "Backspace"
    ) {
      event.preventDefault();
      reject(candidate);
    }
  };

  const job = () => workspace.detection.detectionJob();
  const jobState = () => job()?.state;
  const jobKind = () => job()?.kind;
  const jobIsTerminal = () => isTerminalState(jobState());

  return (
    <section
      class="detection-panel"
      aria-labelledby="detection-heading"
      onKeyDown={handleReviewKeyDown}
    >
      <header class="task-heading detection-heading">
        <div>
          <h2 id="detection-heading">Auto-detect</h2>
        </div>
        <Show when={workspace.detection.detectionCandidates().length > 0}>
          <span class="badge badge-sm badge-neutral">
            {workspace.detection.detectionCandidates().length} pending
          </span>
        </Show>
      </header>

      <Show
        when={workspace.selected() && workspace.activeItemId()}
        fallback={
          <div class="detection-empty-state" role="status">
            <CircleAlert size={18} aria-hidden="true" />
            <div>
              <strong>Add a media item first</strong>
              <p>Auto-detect works on the active project item and its saved revision.</p>
            </div>
          </div>
        }
      >
        <Show when={workspace.detection.detectionQueryError()}>
          {(message) => (
            <Notice variant="error">
              <CircleAlert size={16} aria-hidden="true" />
              <span>{message()}</span>
            </Notice>
          )}
        </Show>

        <div class="detection-workflow-group">
          <div class="detection-methods" aria-label="Detection methods">
            <div class="detection-method-row">
              <button
                class="btn btn-primary btn-sm"
                disabled={!canStart()}
                title={kindDescription.silence}
                onClick={() => void start("silence")}
              >
                <Sparkles size={15} aria-hidden="true" /> Find pauses
              </button>
            </div>
            <div class="detection-method-row">
              <button
                class="btn btn-ghost btn-sm"
                disabled={!canStart()}
                title={kindDescription.black}
                onClick={() => void start("black")}
              >
                <ScanLine size={15} aria-hidden="true" /> Find black sections
              </button>
            </div>
            <div class="detection-method-row">
              <button
                class="btn btn-ghost btn-sm"
                disabled={!canStart()}
                title={kindDescription.scene}
                onClick={() => void start("scene")}
              >
                <Crosshair size={15} aria-hidden="true" /> Find scene changes
              </button>
            </div>
          </div>
        </div>

        <Show
          when={
            workspace.detection.detectionLoading() ||
            jobState() === "queued" ||
            jobState() === "running" ||
            starting()
          }
        >
          <Notice variant="info" busy={true}>
            <div class="detection-job-state-main">
              <LoaderCircle class="spin" size={18} aria-hidden="true" />
              <div>
                <strong>
                  {starting()
                    ? "Preparing detection…"
                    : jobState() === "queued"
                      ? "Detection queued"
                      : jobState() === "running"
                        ? "Detection running"
                        : "Updating detection status…"}
                </strong>
                <span>
                  {jobKind() ? `${kindLabel[jobKind()!]} · ` : ""}
                  {workspace.detection.detectionStatus() ||
                    "The server is scanning this media item."}
                </span>
              </div>
            </div>
            <Show when={!starting() && (jobState() === "queued" || jobState() === "running")}>
              <button
                class="btn btn-ghost btn-sm"
                type="button"
                onClick={() => void workspace.detection.cancelDetection()}
              >
                <X size={15} aria-hidden="true" /> Cancel detection
              </button>
            </Show>
          </Notice>
        </Show>

        <Show when={jobIsTerminal()}>
          <Notice
            variant={
              jobState() === "succeeded" ? "success" : jobState() === "failed" ? "error" : "warning"
            }
          >
            <div class="detection-job-state-main">
              {jobState() === "succeeded" ? (
                <CheckCircle2 size={18} aria-hidden="true" />
              ) : (
                <CircleAlert size={18} aria-hidden="true" />
              )}
              <div>
                <strong>
                  {jobState() === "succeeded"
                    ? "Detection complete"
                    : jobState() === "cancelled"
                      ? "Detection cancelled"
                      : "Detection failed"}
                </strong>
                <span>
                  {jobKind() ? `${kindLabel[jobKind()!]} · ` : ""}
                  {workspace.detection.detectionStatus()}
                </span>
              </div>
            </div>
            <Show when={workspace.detection.detectionLoading()}>
              <LoaderCircle class="spin" size={15} aria-label="Updating detection status" />
            </Show>
          </Notice>
        </Show>

        <details class="detection-options">
          <summary>
            <SlidersHorizontal size={15} aria-hidden="true" /> Advanced
          </summary>
          <fieldset
            ref={(element) => {
              optionsElement = element;
            }}
            class="option-fields"
            disabled={active()}
          >
            <label>
              Silence threshold (dB)
              <input
                class="input input-sm"
                type="number"
                min="-100"
                max="0"
                step="1"
                value={options().noiseDb ?? ""}
                placeholder="Default"
                onInput={(event) => updateOption("noiseDb", event.currentTarget.value)}
              />
              <span class="control-help">Lower values require quieter audio.</span>
            </label>
            <label>
              Minimum duration (ms)
              <input
                class="input input-sm"
                type="number"
                min="0"
                max="86400000"
                step="1"
                value={options().minDurationMs ?? ""}
                placeholder="Default"
                onInput={(event) => updateOption("minDurationMs", event.currentTarget.value)}
              />
              <span class="control-help">
                Used for pause and black-section ranges; maximum 24 hours.
              </span>
            </label>
            <label>
              Scene threshold
              <input
                class="input input-sm"
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={options().sceneThreshold ?? ""}
                placeholder="Default"
                onInput={(event) => updateOption("sceneThreshold", event.currentTarget.value)}
              />
              <span class="control-help">Range 0–1. Higher values find fewer changes.</span>
            </label>
            <div class="detection-option-actions">
              <button
                class="btn btn-ghost btn-xs"
                type="button"
                disabled={active() || Object.keys(options()).length === 0}
                onClick={() => setOptions({})}
              >
                Reset overrides
              </button>
            </div>
          </fieldset>
        </details>

        <Show
          when={
            jobState() === "succeeded" && workspace.detection.detectionCandidates().length === 0
          }
        >
          <div class="detection-empty-state detection-empty-state-result" role="status">
            <CheckCircle2 size={18} aria-hidden="true" />
            <div>
              <strong>
                {job()?.candidates?.length ? "All candidates reviewed" : "No candidates found"}
              </strong>
              <p>
                {job()?.candidates?.length
                  ? "Save the project to keep accepted edits."
                  : "Try a different sensitivity or scan another detection method."}
              </p>
            </div>
          </div>
        </Show>

        <Show when={workspace.detection.detectionCandidates().length > 0}>
          <div class="detection-review" aria-label="Detection review">
            <div class="detection-review-heading">
              <button
                class="btn btn-sm"
                type="button"
                title="Accept all valid candidates"
                disabled={active()}
                onClick={() => {
                  acceptAll().catch((error: unknown) =>
                    workspace.setStatus(`Could not accept candidates: ${String(error)}`),
                  );
                }}
              >
                <CheckCircle2 size={15} aria-hidden="true" /> Accept all valid
              </button>
            </div>
            <ol aria-label="Detection candidates">
              <For each={workspace.detection.detectionCandidates()}>
                {(candidate, index) => (
                  <li
                    ref={(element) => candidateRows.set(candidate.id, element)}
                    tabIndex={index() === reviewIndex() ? 0 : -1}
                    aria-current={index() === reviewIndex() ? "true" : undefined}
                    aria-label={`Detection candidate ${index() + 1}: ${candidateLabel(candidate, workspace.editor.duration())}`}
                    data-detection-candidate={candidate.id}
                    onFocus={() => setReviewIndex(index())}
                  >
                    <div class="detection-candidate-copy">
                      <div class="detection-candidate-title">
                        <span class="badge badge-sm">{kindLabel[candidate.source]}</span>
                        <strong>{candidateLabel(candidate, workspace.editor.duration())}</strong>
                      </div>
                    </div>
                    <div class="detection-candidate-actions">
                      <button
                        class="btn btn-ghost btn-sm"
                        type="button"
                        title="Preview candidate"
                        aria-label={`Preview candidate ${index() + 1}`}
                        disabled={!canStreamPreview()}
                        onClick={() => preview(candidate, index())}
                      >
                        <Play size={15} aria-hidden="true" /> Preview
                      </button>
                      <Show
                        when={
                          candidate.source === "scene" && candidatePointMs(candidate) !== undefined
                        }
                      >
                        <button
                          class="btn btn-ghost btn-sm"
                          type="button"
                          title="Seek to scene change"
                          aria-label="Seek to point"
                          onClick={() => seek(candidate)}
                        >
                          <Crosshair size={15} aria-hidden="true" /> Seek to point
                        </button>
                      </Show>
                      <Show when={candidate.source !== "scene"}>
                        <button
                          class="btn btn-sm"
                          type="button"
                          title="Accept candidate"
                          aria-label="Add segment"
                          aria-keyshortcuts="A Enter"
                          data-action="accept-candidate"
                          onClick={() => accept(candidate)}
                        >
                          <CheckCircle2 size={15} aria-hidden="true" />
                        </button>
                      </Show>
                      <button
                        class="btn btn-ghost btn-sm"
                        type="button"
                        title="Dismiss candidate"
                        aria-label="Dismiss"
                        aria-keyshortcuts="R X N Delete Backspace"
                        data-action="reject-candidate"
                        onClick={() => reject(candidate)}
                      >
                        <X size={15} aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                )}
              </For>
            </ol>
          </div>
        </Show>
      </Show>

      <Show
        when={
          !active() &&
          !jobIsTerminal() &&
          !workspace.detection.detectionQueryError() &&
          workspace.detection.detectionStatus()
        }
      >
        {(message) => <Notice>{message()}</Notice>}
      </Show>
    </section>
  );
}
