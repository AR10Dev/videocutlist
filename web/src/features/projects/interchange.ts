import { Effect, Exit, Stream } from "effect";
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

export function readInterchangeFile(file: Blob): Effect.Effect<string, Error> {
  return Effect.suspend(() => {
    if (!validInterchangeFileSize(file.size))
      return Effect.fail(new Error("Cut list exceeds the 1 MiB limit."));
    const decoder = new TextDecoder();
    let bytes = 0;
    const onError = (cause: unknown) =>
      cause instanceof Error ? cause : new Error("Cut list could not be read.", { cause });
    return Effect.acquireUseRelease(
      Effect.try({ try: () => file.stream(), catch: onError }),
      (stream) =>
        Stream.fromReadableStream({
          evaluate: () => stream,
          onError,
          releaseLockOnEnd: true,
        }).pipe(
          Stream.runFoldEffect(
            () => "",
            (text, chunk) => {
              bytes += chunk.byteLength;
              return bytes > MAX_INTERCHANGE_FILE_BYTES
                ? Effect.fail(new Error("Cut list exceeds the 1 MiB limit."))
                : Effect.succeed(text + decoder.decode(chunk, { stream: true }));
            },
          ),
          Effect.map((text) => text + decoder.decode()),
        ),
      // Effect's native stream finalizer releases the reader; cancel the unlocked source on failure.
      (stream, exit) =>
        Exit.isFailure(exit)
          ? Effect.promise(() => stream.cancel().catch(() => undefined))
          : Effect.void,
    );
  });
}

function attachmentFilename(response: Response, format: InterchangeFormat): string {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encoded = disposition.match(/(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;\s"]+))\s*(?:;|$)/i);
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

export function readInterchangeAttachment(
  api: Pick<NativeMediaApiClient, "mediaRequest">,
  projectId: string,
  itemId: string,
  format: InterchangeFormat,
): Effect.Effect<{ blob: Blob; filename: string }, Error> {
  return Effect.suspend(() => {
    const onError = (cause: unknown) =>
      cause instanceof Error ? cause : new Error("Cut list download failed.", { cause });
    const query = new URLSearchParams({ itemId });
    return Effect.scoped(
      Effect.gen(function* () {
        const response = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: async (signal) => {
              const response = await api.mediaRequest(
                `projects/${encodeURIComponent(projectId)}/interchange/${format}?${query}`,
                { signal },
              );
              // Native/test transports may resolve after abort; do not leak that late body.
              if (signal.aborted) {
                await response.body?.cancel().catch(() => undefined);
                throw new DOMException("Download cancelled.", "AbortError");
              }
              return response;
            },
            catch: onError,
          }),
          (response, exit) =>
            Exit.isFailure(exit) && response.body
              ? Effect.promise(() => response.body!.cancel().catch(() => undefined))
              : Effect.void,
          { interruptible: true },
        );
        const chunks: ArrayBuffer[] = [];
        let size = 0;
        if (response.body) {
          yield* Stream.fromReadableStream({
            evaluate: () => response.body!,
            onError,
            releaseLockOnEnd: true,
          }).pipe(
            Stream.runForEach((value) => {
              size += value.byteLength;
              if (size > MAX_INTERCHANGE_ATTACHMENT_BYTES)
                return Effect.fail(new Error("Cut list attachment exceeds the download limit."));
              const chunk = new ArrayBuffer(value.byteLength);
              new Uint8Array(chunk).set(value);
              chunks.push(chunk);
              return Effect.void;
            }),
          );
        }
        const blob = new Blob(chunks, {
          type: response.headers.get("Content-Type") ?? "text/plain",
        });
        if (!response.ok) {
          const error = yield* Effect.tryPromise({
            try: () => readApiError(new Response(blob, { headers: response.headers })),
            catch: onError,
          });
          return yield* Effect.fail(new ApiFailure(response.status, error));
        }
        if (!response.body) return yield* Effect.fail(new Error("Cut list attachment is missing."));
        return { blob, filename: attachmentFilename(response, format) };
      }),
    );
  });
}

/** Native download handoff: retain the URL through the next browser task. */
export function downloadInterchangeAttachment(attachment: { blob: Blob; filename: string }) {
  return Effect.acquireUseRelease(
    Effect.try(() => URL.createObjectURL(attachment.blob)),
    (url) =>
      Effect.try(() => {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = attachment.filename;
        anchor.click();
      }),
    // Finalizers are uninterruptible: even close immediately after click must allow handoff.
    (url) =>
      Effect.callback<void>((resume) => {
        const timer = setTimeout(() => resume(Effect.void), 0);
        return Effect.sync(() => clearTimeout(timer));
      }).pipe(Effect.andThen(Effect.sync(() => URL.revokeObjectURL(url)))),
  );
}
