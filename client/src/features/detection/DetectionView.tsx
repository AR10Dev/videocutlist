import { createEffect, createSignal, For, Show } from "solid-js";
import { canStreamPreview, formatTime } from "../preview/model";
import type { Candidate } from "./model";
import { useWorkspace } from "../app/WorkspaceContext";

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
  const start = async (kind: "silence" | "black" | "scene") => {
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

  return (
    <section
      class="detection-panel"
      aria-labelledby="detection-heading"
      onKeyDown={handleReviewKeyDown}
    >
      <h2 id="detection-heading">Detection</h2>
      <p>
        Start a goal-oriented scan, preview each bounded candidate, then accept only the cuts you
        want.
      </p>
      <p role="status" aria-live="polite">
        {workspace.detectionStatus()}
      </p>
      <div class="detection-methods" aria-label="Detection workflows">
        <h3 class="sr-only">Goal-oriented workflows</h3>
        <button class="btn btn-sm" disabled={active()} onClick={() => void start("silence")}>
          Remove silence
        </button>
        <button class="btn btn-sm" disabled={active()} onClick={() => void start("scene")}>
          Split into scenes
        </button>
        <button
          class="btn btn-ghost btn-sm"
          disabled={active()}
          onClick={() => void start("silence")}
        >
          Find silence
        </button>
        <button
          class="btn btn-ghost btn-sm"
          disabled={active()}
          onClick={() => void start("black")}
        >
          Find black frames
        </button>
        <button
          class="btn btn-ghost btn-sm"
          disabled={active()}
          onClick={() => void start("scene")}
        >
          Find scene changes
        </button>
        <Show when={!starting() && active()}>
          <button class="btn btn-ghost btn-sm" onClick={() => void workspace.cancelDetection()}>
            Cancel detection
          </button>
        </Show>
      </div>
      <details>
        <summary>Detection sensitivity</summary>
        <fieldset
          ref={(element) => {
            optionsElement = element;
          }}
          class="option-fields"
          disabled={active()}
        >
          <legend>Optional overrides</legend>
          <For
            each={[
              {
                key: "noiseDb" as const,
                label: "Silence threshold (dB)",
                min: -100,
                max: 0,
                step: 1,
              },
              {
                key: "minDurationMs" as const,
                label: "Minimum duration (ms)",
                min: 0,
                max: 86400000,
                step: 1,
              },
              {
                key: "sceneThreshold" as const,
                label: "Scene threshold",
                min: 0,
                max: 1,
                step: 0.01,
              },
            ]}
          >
            {(field) => (
              <label>
                {field.label}
                <input
                  class="input input-sm w-full"
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  placeholder="Server default"
                  onInput={(event) =>
                    setOptions((current) => ({
                      ...current,
                      [field.key]:
                        event.currentTarget.value === ""
                          ? undefined
                          : event.currentTarget.valueAsNumber,
                    }))
                  }
                />
              </label>
            )}
          </For>
          <p>
            Leave blank to use the server defaults. Scene threshold ranges from 0 to 1; higher
            values find fewer changes.
          </p>
        </fieldset>
      </details>
      <Show when={workspace.detectionCandidates().length > 0}>
        <div class="detection-review" aria-label="Detection review">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="m-0">Review candidates</h3>
            <button
              class="btn btn-sm"
              type="button"
              title="Accept all valid candidates"
              disabled={active()}
              onClick={acceptAll}
            >
              Accept all valid
            </button>
          </div>
          <p class="shortcut-help">
            Focus a candidate, then press <kbd class="kbd kbd-xs">A</kbd> to accept or{" "}
            <kbd class="kbd kbd-xs">R</kbd> to reject. Each action advances to the next candidate.
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
                  <span>
                    {candidate.source} · {formatTime(candidate.startMs, workspace.duration())}–
                    {formatTime(candidate.endMs, workspace.duration())} ·{" "}
                    {Math.round(candidate.confidence * 100)}%
                  </span>{" "}
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    title="Preview candidate"
                    aria-label={`Preview candidate ${index() + 1}`}
                    disabled={!canStreamPreview()}
                    onClick={() => preview(candidate, index())}
                  >
                    Preview
                  </button>{" "}
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    title="Accept candidate"
                    aria-label="Add segment"
                    aria-keyshortcuts="A Enter"
                    data-action="accept-candidate"
                    onClick={() => accept(candidate)}
                  >
                    Add segment
                  </button>{" "}
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    title="Reject candidate"
                    aria-label="Dismiss"
                    aria-keyshortcuts="R X N Delete Backspace"
                    data-action="reject-candidate"
                    onClick={() => reject(candidate)}
                  >
                    Dismiss
                  </button>
                </li>
              )}
            </For>
          </ol>
        </div>
      </Show>
    </section>
  );
}
