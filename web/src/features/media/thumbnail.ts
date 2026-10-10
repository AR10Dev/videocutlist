import { Effect } from "effect";
import type { ServerState } from "../app/server";
import type { NativeMediaApiClient } from "../../api";
import type { Media } from "../../generated/effect-api";

type ObjectURLAPI = Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;

export async function createThumbnailObjectURL(
  response: Response,
  signal: AbortSignal,
  urlAPI: ObjectURLAPI = URL,
): Promise<string | undefined> {
  const body = response.body;
  if (!response.ok || signal.aborted) {
    await body?.cancel().catch(() => undefined);
    return;
  }
  if (!body) return;

  const reader = body.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (signal.aborted) return;
  const blob = new Blob(
    chunks.map((chunk) => new Uint8Array(chunk)),
    { type: response.headers.get("Content-Type") ?? "" },
  );
  const url = urlAPI.createObjectURL(blob);
  if (signal.aborted) {
    urlAPI.revokeObjectURL(url);
    return;
  }
  return url;
}

export function libraryThumbnail(
  server: ServerState,
  api: Pick<NativeMediaApiClient, "assetRequest">,
  item: Media,
) {
  return server.runtime.atom(
    Effect.gen(function* () {
      const urls = yield* Effect.acquireRelease(
        Effect.sync(() => new Set<string>()),
        (urls) => Effect.sync(() => urls.forEach((url) => URL.revokeObjectURL(url))),
      );
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await api.assetRequest(
            item.id,
            "thumbnails",
            {
              startMs: 0,
              durationMs: Math.max(1, Math.min(item.durationMs, 120_000)),
              count: 1,
              width: 240,
            },
            { signal },
          );
          const url = await createThumbnailObjectURL(response, signal);
          if (url) {
            if (signal.aborted) URL.revokeObjectURL(url);
            else urls.add(url);
          }
          return signal.aborted ? undefined : url;
        },
        catch: () => new Error("Thumbnail unavailable."),
      });
    }),
  );
}
