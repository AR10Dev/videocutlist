import { createSignal, Show } from "solid-js";
import { createApiClient, resolveBrowserConfiguration } from "../../api";

const api = createApiClient(resolveBrowserConfiguration());

/** Prepare one authenticated archive without exposing server paths. */
export function BatchDownload(props: { batchId: string; outputCount: number }) {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  let controller: AbortController | undefined;
  const path = () => `batches/${encodeURIComponent(props.batchId)}/download`;
  const download = async () => {
    if (pending() || props.outputCount < 2) return;
    const requestController = new AbortController();
    controller = requestController;
    setPending(true);
    setError("");
    try {
      const response = await api.request(path(), { signal: requestController.signal });
      if (!response.ok) throw new Error(`Download failed (${response.status}). Try again.`);
      const url = URL.createObjectURL(await response.blob());
      if (requestController.signal.aborted) {
        URL.revokeObjectURL(url);
        return;
      }
      const link = document.createElement("a");
      link.href = url;
      link.download = "videocutlist-clips.zip";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      if (requestController.signal.aborted) setError("Download cancelled.");
      else setError(cause instanceof Error ? cause.message : "Download failed. Try again.");
    } finally {
      if (controller === requestController) controller = undefined;
      setPending(false);
    }
  };
  const cancel = () => controller?.abort();
  return (
    <div class="controls" aria-busy={pending()}>
      <button
        class="btn btn-sm"
        type="button"
        disabled={pending() || props.outputCount < 2}
        onClick={() => void download()}
      >
        {pending() ? "Preparing all clips…" : "Download all clips"}
      </button>
      <Show when={pending()}>
        <button class="btn btn-ghost btn-sm" type="button" onClick={cancel}>
          Cancel download
        </button>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </div>
  );
}
