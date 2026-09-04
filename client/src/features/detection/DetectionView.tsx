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
    <section class="detection-panel" aria-labelledby="detection-heading">
      <h2 id="detection-heading">Auto detection</h2>
      <details open>
        <summary>Detection tools</summary>
        <p role="status">{detectionStatus() || "Review candidates before they change segments."}</p>
        <div class="detection-methods" aria-label="Detection methods">
          <div>
            <button disabled={active()} onClick={() => void startDetection("silence")}>
              Detect silence
            </button>
            <p>Find quiet ranges that may separate usable clips.</p>
          </div>
          <div>
            <button disabled={active()} onClick={() => void startDetection("black")}>
              Detect black frames
            </button>
            <p>Find black frames that may mark transitions.</p>
          </div>
          <div>
            <button disabled={active()} onClick={() => void startDetection("scene")}>
              Detect scene changes
            </button>
            <p>Suggest boundaries where the picture changes.</p>
          </div>
          <Show when={active()}>
            <button onClick={() => void cancelDetection()}>Cancel detection</button>
          </Show>
        </div>
        <Show when={detectionCandidates().length > 0}>
          <ol aria-label="Detection candidates">
            <For each={detectionCandidates()}>
              {(candidate) => (
                <li>
                  {candidate.source} · {formatTime(candidate.startMs, duration())}–
                  {formatTime(candidate.endMs, duration())} ·{" "}
                  {Math.round(candidate.confidence * 100)}%{" "}
                  <button onClick={() => acceptDetection(candidate)}>Accept</button>{" "}
                  <button
                    onClick={() => {
                      setDetectionCandidates(
                        detectionCandidates().filter((item) => item.id !== candidate.id),
                      );
                      setDetectionStatus("Candidate rejected.");
                    }}
                  >
                    Reject
                  </button>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </details>
    </section>
  );
}
