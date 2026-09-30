import { Show } from "solid-js";
import { createApiClient, resolveBrowserConfiguration } from "../../api";
import { createExportDownload, downloadExport } from "./download";

const configuration = resolveBrowserConfiguration();
const api = createApiClient(configuration);
/** Prepare one authenticated archive without exposing server paths. */
export function BatchDownload(props: { batchId: string; outputCount: number }) {
  const { pending, error, download, cancel } = createExportDownload((signal) =>
    downloadExport(
      api,
      `batches/${encodeURIComponent(props.batchId)}/download`,
      "videocutlist-clips.zip",
      configuration.authentication,
      signal,
    ),
  );
  return (
    <div class="controls" aria-busy={pending()}>
      <button
        class="btn btn-sm"
        type="button"
        disabled={pending() || props.outputCount < 2}
        onClick={() => {
          if (props.outputCount < 2) return;
          void download();
        }}
      >
        {pending() ? "Downloading all clips…" : "Download all clips"}
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
