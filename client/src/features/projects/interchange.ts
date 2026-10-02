import {
  ApiFailure,
  MAX_INTERCHANGE_FILE_BYTES,
  readApiError,
  validInterchangeFileSize,
  type NativeMediaApiClient,
} from "../../api";

export type InterchangeFormat = "csv" | "chapters";
// 10,000 legal rows with 200 four-byte runes per label remain below this cap.
export const MAX_INTERCHANGE_ATTACHMENT_BYTES = 16 << 20;

export async function readInterchangeFile(file: Blob, signal: AbortSignal): Promise<string> {
  if (!validInterchangeFileSize(file.size)) throw new Error("Cut list exceeds the 1 MiB limit.");
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let complete = false;
  const cancel = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Import cancelled.", "AbortError");
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_INTERCHANGE_FILE_BYTES) throw new Error("Cut list exceeds the 1 MiB limit.");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function attachmentFilename(response: Response, format: InterchangeFormat): string {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encoded = disposition.match(/(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;\s]*))/i);
  let name: string | undefined;
  try {
    name = encoded ? decodeURIComponent(encoded.trim()) : (quoted?.[1] ?? quoted?.[2]);
  } catch {
    name = undefined;
  }
  if (
    !name ||
    [...name].some((character) => {
      const code = character.charCodeAt(0);
      return character === "/" || character === "\\" || code <= 31 || code === 127;
    }) ||
    name === "." ||
    name === ".."
  )
    return `cutlist.${format}`;
  return name;
}

export async function readInterchangeAttachment(
  api: Pick<NativeMediaApiClient, "mediaRequest">,
  projectId: string,
  itemId: string,
  format: InterchangeFormat,
  signal: AbortSignal,
): Promise<{ blob: Blob; filename: string }> {
  const query = new URLSearchParams({ itemId });
  const response = await api.mediaRequest(
    `projects/${encodeURIComponent(projectId)}/interchange/${format}?${query}`,
    { signal },
  );
  if (!response.ok) throw new ApiFailure(response.status, await readApiError(response));
  const reader = response.body?.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  let complete = false;
  const cancel = () => {
    if (reader) void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (reader) {
      if (signal.aborted) throw new DOMException("Download cancelled.", "AbortError");
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      size += value.byteLength;
      if (size > MAX_INTERCHANGE_ATTACHMENT_BYTES)
        throw new Error("Cut list attachment exceeds the download limit.");
      const chunk = new ArrayBuffer(value.byteLength);
      new Uint8Array(chunk).set(value);
      chunks.push(chunk);
    }
    if (signal.aborted) throw new DOMException("Download cancelled.", "AbortError");
    return {
      blob: new Blob(chunks, { type: response.headers.get("Content-Type") ?? "text/plain" }),
      filename: attachmentFilename(response, format),
    };
  } finally {
    signal.removeEventListener("abort", cancel);
    if (reader) {
      if (!complete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
