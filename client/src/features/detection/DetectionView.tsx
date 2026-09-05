import { createSignal, For, Show } from "solid-js";
import { formatTime } from "../preview/model";
import { useWorkspace } from "../app/WorkspaceContext";

export function DetectionView() {
  const [options, setOptions] = createSignal<{
    noiseDb?: number;
    minDurationMs?: number;
    sceneThreshold?: number;
  }>({});
  const [starting, setStarting] = createSignal(false);
  let optionsElement: HTMLFieldSetElement | undefined;
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
      await startDetection(kind, options());
    } finally {
      setStarting(false);
    }
  };
  const {
    duration,
    detectionStatus,
    detectionJob,
    detectionCandidates,
    setDetectionCandidates,
    setDetectionStatus,
    startDetection,
    cancelDetection,
    acceptDetection,
  } = useWorkspace();
  const active = () =>
    starting() || detectionJob()?.state === "queued" || detectionJob()?.state === "running";
  return (
    <section class="detection-panel" aria-labelledby="detection-heading">
      <h2 id="detection-heading">Detection</h2>
      <p>
        Find suggested cuts, then review and accept only the ones you want. Your project is saved
        before scanning.
      </p>
      <p role="status">{detectionStatus()}</p>
      <div class="detection-methods" aria-label="Detection methods">
        <button class="btn btn-ghost btn-sm" disabled={active()} onClick={() => start("silence")}>
          Find silence
        </button>
        <button class="btn btn-ghost btn-sm" disabled={active()} onClick={() => start("black")}>
          Find black frames
        </button>
        <button class="btn btn-ghost btn-sm" disabled={active()} onClick={() => start("scene")}>
          Find scene changes
        </button>
        <Show when={!starting() && active()}>
          <button class="btn btn-ghost btn-sm" onClick={() => void cancelDetection()}>
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
      <Show when={detectionCandidates().length > 0}>
        <ol aria-label="Detection candidates">
          <For each={detectionCandidates()}>
            {(candidate) => (
              <li>
                {candidate.source} · {formatTime(candidate.startMs, duration())}–
                {formatTime(candidate.endMs, duration())} · {Math.round(candidate.confidence * 100)}
                %{" "}
                <button class="btn btn-ghost btn-sm" onClick={() => acceptDetection(candidate)}>
                  Add segment
                </button>{" "}
                <button
                  class="btn btn-ghost btn-sm"
                  onClick={() => {
                    setDetectionCandidates(
                      detectionCandidates().filter((item) => item.id !== candidate.id),
                    );
                    setDetectionStatus("Candidate dismissed.");
                  }}
                >
                  Dismiss
                </button>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </section>
  );
}
