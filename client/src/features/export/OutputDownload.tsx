import { createSignal, Show } from "solid-js";
import { createApiClient, resolveBrowserConfiguration } from "../../api";
import { downloadExport } from "./download";

const api = createApiClient(resolveBrowserConfiguration());

/** Fetch with the configured credentials; navigation alone cannot send bearer auth. */
export function OutputDownload(props: { jobId: string; position: number; name: string }) {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  const path = () => `jobs/${encodeURIComponent(props.jobId)}/outputs/${props.position}`;
  const download = async () => {
    if (pending()) return;
    setPending(true);
    setError("");
    try {
      await downloadExport(api, path(), props.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Download failed. Try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <div>
      <a
        class="link"
        href={api.url(path())}
        download={props.name}
        aria-disabled={pending()}
        onClick={(event) => {
          event.preventDefault();
          void download();
        }}
      >
        {pending() ? "Downloading…" : `Download output ${props.position + 1}`}
      </a>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </div>
  );
}
