import { createSignal, Show } from "solid-js";
import { createApiClient, resolveBrowserConfiguration } from "../../api";
import { downloadExport } from "./download";

const configuration = resolveBrowserConfiguration();
const api = createApiClient(configuration);

/** Stream a protected output without making its API URL a navigable link. */
export function OutputDownload(props: { jobId: string; position: number; name: string }) {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  let controller: AbortController | undefined;
  const path = () => `jobs/${encodeURIComponent(props.jobId)}/outputs/${props.position}`;
  const download = async () => {
    if (pending()) return;
    const requestController = new AbortController();
    controller = requestController;
    setPending(true);
    setError("");
    try {
      await downloadExport(
        api,
        path(),
        props.name,
        configuration.authentication,
        requestController.signal,
      );
    } catch (cause) {
      if (requestController.signal.aborted) setError("Download cancelled.");
      else setError(cause instanceof Error ? cause.message : "Download failed. Try again.");
    } finally {
      if (controller === requestController) controller = undefined;
      setPending(false);
    }
  };
  return (
    <div>
      <button
        class="btn btn-link"
        type="button"
        disabled={pending()}
        onClick={() => void download()}
      >
        {pending() ? "Downloading…" : `Download output ${props.position + 1}`}
      </button>
      <Show when={pending()}>
        <button class="btn btn-ghost btn-sm" type="button" onClick={() => controller?.abort()}>
          Cancel download
        </button>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </div>
  );
}
