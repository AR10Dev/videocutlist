import type { ApiClient } from "../../api";

/** Buffer an authenticated export before handing it to the browser download manager. */
export async function downloadExport(
  api: ApiClient,
  path: string,
  name: string,
  signal?: AbortSignal,
) {
  const response = await api.request(path, { signal });
  if (!response.ok) throw new Error(`Download failed (${response.status}). Try again.`);
  const url = URL.createObjectURL(await response.blob());
  if (signal?.aborted) {
    URL.revokeObjectURL(url);
    return;
  }
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
