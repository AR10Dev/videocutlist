import { For, Show } from "solid-js";
import { formatTime } from "../preview/model";
import { useWorkspace } from "../app/WorkspaceContext";

export function DetectionView() {
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
  const active = () => detectionJob()?.state === "queued" || detectionJob()?.state === "running";
  return (
    <section class="detection-panel flex flex-col gap-4 p-4" aria-labelledby="detection-heading">
      <h2 id="detection-heading">Detection</h2>
      <p role="status">{detectionStatus()}</p>
      <div class="detection-methods" aria-label="Detection methods">
        <button
          class="btn btn-ghost btn-sm"
          disabled={active()}
          onClick={() => void startDetection("silence")}
        >
          Find silence
        </button>
        <button
          class="btn btn-ghost btn-sm"
          disabled={active()}
          onClick={() => void startDetection("black")}
        >
          Find black frames
        </button>
        <button
          class="btn btn-ghost btn-sm"
          disabled={active()}
          onClick={() => void startDetection("scene")}
        >
          Find scene changes
        </button>
        <Show when={active()}>
          <button class="btn btn-ghost btn-sm" onClick={() => void cancelDetection()}>
            Cancel detection
          </button>
        </Show>
      </div>
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
