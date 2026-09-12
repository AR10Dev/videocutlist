import { createEffect, createSignal, For, Show } from "solid-js";
import {
  CheckCircle2,
  CircleAlert,
  Crosshair,
  LoaderCircle,
  Play,
  ScanLine,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-solid";
import { canStreamPreview, formatTime } from "../preview/model";
import type { Candidate, DetectionKind } from "./model";
import { useWorkspace } from "../app/WorkspaceContext";

const kindLabel: Record<DetectionKind, string> = {
  silence: "Silence",
  black: "Black frames",
  scene: "Scene changes",
};

const kindDescription: Record<DetectionKind, string> = {
  silence: "Find quiet ranges to remove or review.",
  black: "Find sustained black ranges in the picture.",
  scene: "Find cut points between visual scenes.",
};

const formatCandidateDuration = (candidate: Candidate) =>
  formatTime(candidate.endMs - candidate.startMs, candidate.endMs - candidate.startMs);

export function DetectionView() {
  const workspace = useWorkspace();
  const [options, setOptions] = createSignal<{
    noiseDb?: number;
    minDurationMs?: number;
    sceneThreshold?: number;
  }>({});
  const [starting, setStarting] = createSignal(false);
  const [reviewIndex, setReviewIndex] = createSignal(0);
  let optionsElement: HTMLFieldSetElement | undefined;
  const candidateRows = new Map<string, HTMLLIElement>();

  createEffect(() => {
    const candidates = workspace.detectionCandidates();
    if (!candidates.length) {
      setReviewIndex(0);
    } else if (reviewIndex() >= candidates.length) {
      setReviewIndex(candidates.length - 1);
    }
  });

  const focusCandidate = (candidate: Candidate | undefined) => {
    if (!candidate) return;
    const index = workspace.detectionCandidates().findIndex((item) => item.id === candidate.id);
    if (index < 0) return;
    setReviewIndex(index);
    queueMicrotask(() => candidateRows.get(candidate.id)?.focus());
  };
  const focusNextCandidate = (index: number) => {
    const candidates = workspace.detectionCandidates();
    focusCandidate(candidates[Math.min(index, candidates.length - 1)]);
  };
  const accept = (candidate: Candidate) => {
    const index = workspace.detectionCandidates().findIndex((item) => item.id === candidate.id);
    const result = workspace.acceptDetection(candidate);
    if (result.accepted.length) focusNextCandidate(index);
  };
  const reject = (candidate: Candidate) => {
    const index = workspace.detectionCandidates().findIndex((item) => item.id === candidate.id);
    workspace.rejectDetection(candidate);
    focusNextCandidate(index);
  };
  const preview = (candidate: Candidate, index: number) => {
    setReviewIndex(index);
    workspace.setDetectionStatus(`Previewing candidate ${index + 1}.`);
    workspace.playDetectionCandidate({
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      label: candidate.source,
    });
  };
  const updateOption = (key: "noiseDb" | "minDurationMs" | "sceneThreshold", value: string) => {
    setOptions((current) => ({
      ...current,
      [key]: value === "" ? undefined : Number(value),
    }));
  };
  const start = async (kind: DetectionKind) => {
    if (starting()) return;
    const invalid = optionsElement?.querySelector<HTMLInputElement>("input:invalid");
    if (invalid) {
      optionsElement!.closest("details")!.open = true;
      invalid.reportValidity();
      return;
    }
    setStarting(true);
    try {
      await workspace.startDetection(kind, options());
    } finally {
      setStarting(false);
    }
  };
  const active = () =>
    starting() ||
    workspace.detectionJob()?.state === "queued" ||
    workspace.detectionJob()?.state === "running";
  const canStart = () => Boolean(workspace.selected() && workspace.activeItemId()) && !active();
  const acceptAll = () => {
    const candidates = workspace.detectionCandidates();
    if (!candidates.length) return;
    if (
      !window.confirm(
        `Accept all ${candidates.length} detection candidates that are still valid? Stale, invalid, and overlapping candidates will be skipped.`,
      )
    )
      return;
    const result = workspace.bulkAcceptDetection();
    if (result.accepted.length) focusCandidate(workspace.detectionCandidates()[0]);
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
    const candidate = workspace.detectionCandidates()[reviewIndex()];
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

  const job = () => workspace.detectionJob();
  const jobState = () => job()?.state;
  const jobKind = () => job()?.kind;
  const jobIsTerminal = () => {
    const state = jobState();
    return state === "succeeded" || state === "failed" || state === "cancelled";
  };

  return (
    <section
      class="detection-panel"
      aria-labelledby="detection-heading"
      onKeyDown={handleReviewKeyDown}
    >
      <header class="task-heading detection-heading">
        <div>
          <h2 id="detection-heading">Auto-detect</h2>
          <p id="detection-description">
            Scan the active media item, then make every proposed range a deliberate edit.
          </p>
        </div>
        <Show when={workspace.detectionCandidates().length > 0}>
          <span class="badge badge-sm badge-neutral">
            {workspace.detectionCandidates().length} pending
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
        <div class="detection-source-strip" aria-label="Detection source">
          <div class="detection-source-icon" aria-hidden="true">
            <ScanLine size={18} />
          </div>
          <div class="detection-source-copy">
            <strong>{workspace.selected()!.name}</strong>
            <span>
              {formatTime(workspace.duration(), workspace.duration())} · project revision{" "}
              {workspace.revision() || "not saved"}
            </span>
          </div>
        </div>

        <Show when={workspace.detectionQueryError()}>
          {(message) => (
            <div class="alert alert-error alert-soft" role="alert">
              <CircleAlert size={16} aria-hidden="true" />
              <span>{message()}</span>
            </div>
          )}
        </Show>

        <div class="detection-workflow-group">
          <div class="detection-section-label">
            <div>
              <h3>Start with an outcome</h3>
              <p>These actions also set the matching export workflow for you.</p>
            </div>
            <Sparkles size={16} aria-hidden="true" />
          </div>
          <div class="detection-workflow-grid" aria-label="Detection outcomes">
            <div class="detection-workflow-card">
              <button
                class="btn btn-primary btn-sm"
                disabled={!canStart()}
                onClick={() => void start("silence")}
              >
                <Sparkles size={15} aria-hidden="true" /> Remove silence
              </button>
              <p>Mark quiet ranges so exports can keep the rest.</p>
            </div>
            <div class="detection-workflow-card">
              <button class="btn btn-sm" disabled={!canStart()} onClick={() => void start("scene")}>
                <Crosshair size={15} aria-hidden="true" /> Split scenes
              </button>
              <p>Find visual change points to build a cut list.</p>
            </div>
          </div>
        </div>

        <div class="detection-workflow-group">
          <div class="detection-section-label">
            <div>
              <h3>Find candidates</h3>
              <p>Review each bounded result before adding it to the timeline.</p>
            </div>
            <Search size={16} aria-hidden="true" />
          </div>
          <div class="detection-methods" aria-label="Detection methods">
            <div class="detection-method-row">
              <button
                class="btn btn-ghost btn-sm"
                disabled={!canStart()}
                onClick={() => void start("silence")}
              >
                Find silence
              </button>
              <span>{kindDescription.silence}</span>
            </div>
            <div class="detection-method-row">
              <button
                class="btn btn-ghost btn-sm"
                disabled={!canStart()}
                onClick={() => void start("black")}
              >
                Find black frames
              </button>
              <span>{kindDescription.black}</span>
            </div>
            <div class="detection-method-row">
              <button
                class="btn btn-ghost btn-sm"
                disabled={!canStart()}
                onClick={() => void start("scene")}
              >
                Find scene changes
              </button>
              <span>{kindDescription.scene}</span>
            </div>
          </div>
        </div>

        <Show when={jobState() === "queued" || jobState() === "running" || starting()}>
          <div class="detection-job-state" aria-busy="true" role="status">
            <div class="detection-job-state-main">
              <LoaderCircle class="spin" size={18} aria-hidden="true" />
              <div>
                <strong>
                  {starting()
                    ? "Preparing detection…"
                    : jobState() === "queued"
                      ? "Detection queued"
                      : "Detection running"}
                </strong>
                <span>
                  {jobKind() ? `${kindLabel[jobKind()!]} · ` : ""}
                  {workspace.detectionStatus() || "The server is scanning this media item."}
                </span>
              </div>
            </div>
            <Show when={!starting() && (jobState() === "queued" || jobState() === "running")}>
              <button
                class="btn btn-ghost btn-sm"
                type="button"
                onClick={() => void workspace.cancelDetection()}
              >
                <X size={15} aria-hidden="true" /> Cancel detection
              </button>
            </Show>
          </div>
        </Show>

        <Show when={jobIsTerminal()}>
          <div
            class={`detection-job-state detection-job-state-${jobState()}`}
            role={jobState() === "failed" ? "alert" : "status"}
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
                  {workspace.detectionStatus()}
                  <Show when={job()?.errorCode}> · code: {job()!.errorCode}</Show>
                </span>
              </div>
            </div>
            <Show when={workspace.detectionLoading()}>
              <LoaderCircle class="spin" size={15} aria-label="Updating detection status" />
            </Show>
          </div>
        </Show>

        <details class="detection-options">
          <summary>
            <SlidersHorizontal size={15} aria-hidden="true" /> Detection sensitivity
          </summary>
          <fieldset
            ref={(element) => {
              optionsElement = element;
            }}
            class="option-fields"
            disabled={active()}
          >
            <legend>Optional overrides</legend>
            <label>
              Silence threshold (dB)
              <input
                class="input input-bordered input-sm"
                type="number"
                min="-100"
                max="0"
                step="1"
                value={options().noiseDb ?? ""}
                placeholder="Server default"
                onInput={(event) => updateOption("noiseDb", event.currentTarget.value)}
              />
              <span class="control-help">Lower values require quieter audio.</span>
            </label>
            <label>
              Minimum duration (ms)
              <input
                class="input input-bordered input-sm"
                type="number"
                min="0"
                max="86400000"
                step="1"
                value={options().minDurationMs ?? ""}
                placeholder="Server default"
                onInput={(event) => updateOption("minDurationMs", event.currentTarget.value)}
              />
              <span class="control-help">
                Used for silence and black-frame ranges; maximum 24 hours.
              </span>
            </label>
            <label>
              Scene threshold
              <input
                class="input input-bordered input-sm"
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={options().sceneThreshold ?? ""}
                placeholder="Server default"
                onInput={(event) => updateOption("sceneThreshold", event.currentTarget.value)}
              />
              <span class="control-help">Range 0–1. Higher values find fewer changes.</span>
            </label>
            <div class="detection-option-actions">
              <span class="control-help">
                Blank fields and zero values use the server defaults.
              </span>
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

        <Show when={jobState() === "succeeded" && workspace.detectionCandidates().length === 0}>
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

        <Show when={workspace.detectionCandidates().length > 0}>
          <div class="detection-review" aria-label="Detection review">
            <div class="detection-review-heading">
              <div>
                <h3>Review candidates</h3>
                <p>
                  Accepting adds a segment to the timeline. Dismissing leaves the source untouched.
                </p>
              </div>
              <button
                class="btn btn-sm"
                type="button"
                title="Accept all valid candidates"
                disabled={active()}
                onClick={acceptAll}
              >
                <CheckCircle2 size={15} aria-hidden="true" /> Accept all valid
              </button>
            </div>
            <p class="shortcut-help">
              Candidate {reviewIndex() + 1} of {workspace.detectionCandidates().length}. Use A or
              Enter to accept, R/X/N to dismiss.
            </p>
            <ol aria-label="Detection candidates">
              <For each={workspace.detectionCandidates()}>
                {(candidate, index) => (
                  <li
                    ref={(element) => candidateRows.set(candidate.id, element)}
                    tabIndex={index() === reviewIndex() ? 0 : -1}
                    aria-current={index() === reviewIndex() ? "true" : undefined}
                    aria-label={`Detection candidate ${index() + 1}: ${formatTime(candidate.startMs, workspace.duration())} to ${formatTime(candidate.endMs, workspace.duration())}`}
                    data-detection-candidate={candidate.id}
                    onFocus={() => setReviewIndex(index())}
                  >
                    <div class="detection-candidate-copy">
                      <div class="detection-candidate-title">
                        <span class="badge badge-sm">{kindLabel[candidate.source]}</span>
                        <strong>
                          {formatTime(candidate.startMs, workspace.duration())} –{" "}
                          {formatTime(candidate.endMs, workspace.duration())}
                        </strong>
                      </div>
                      <dl>
                        <dt>Duration</dt>
                        <dd>{formatCandidateDuration(candidate)}</dd>
                        <dt>Confidence</dt>
                        <dd>{Math.round(candidate.confidence * 100)}%</dd>
                        <dt>Candidate ID</dt>
                        <dd>
                          <code>{candidate.id}</code>
                        </dd>
                      </dl>
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
                      <button
                        class="btn btn-sm"
                        type="button"
                        title="Accept candidate"
                        aria-label="Add segment"
                        aria-keyshortcuts="A Enter"
                        data-action="accept-candidate"
                        onClick={() => accept(candidate)}
                      >
                        <CheckCircle2 size={15} aria-hidden="true" /> Add segment
                      </button>
                      <button
                        class="btn btn-ghost btn-sm"
                        type="button"
                        title="Reject candidate"
                        aria-label="Dismiss"
                        aria-keyshortcuts="R X N Delete Backspace"
                        data-action="reject-candidate"
                        onClick={() => reject(candidate)}
                      >
                        <X size={15} aria-hidden="true" /> Dismiss
                      </button>
                    </div>
                  </li>
                )}
              </For>
            </ol>
          </div>
        </Show>
      </Show>

      <p class="detection-status" role="status" aria-live="polite">
        {workspace.detectionStatus()}
      </p>
    </section>
  );
}
