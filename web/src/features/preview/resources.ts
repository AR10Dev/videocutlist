import { Effect, Option, Stream } from "effect";
import * as Schema from "effect/Schema";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { NativeMediaApiClient } from "../../api";
import type { ServerState } from "../../app/server";
import type { Media } from "../../generated/effect-api";
import { Waveform as WaveformSchema } from "../../generated/effect-api";
import {
  normalizePeaks,
  normalizedAssetViewport,
  visibleAssetRanges,
  type AssetRange,
  type AssetViewport,
} from "./assets";

type ThumbnailRequestResult = {
  range: AssetRange;
  thumbnailURL?: string;
  thumbnailFailed: boolean;
};

function assetPixelWidth(viewport: AssetViewport): number {
  const width = Number.isFinite(viewport.widthPx) ? Math.max(1, viewport.widthPx ?? 1) : 960;
  return Math.max(16, Math.min(4096, Math.ceil(width * (globalThis.devicePixelRatio || 1))));
}

function loadThumbnail(url: string, signal: AbortSignal): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (value?: HTMLImageElement) => {
      signal.removeEventListener("abort", abort);
      image.onload = null;
      image.onerror = null;
      if (signal.aborted) image.src = "";
      resolve(value);
    };
    const abort = () => finish();
    image.onload = () => finish(image);
    image.onerror = () => finish();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) finish();
    else image.src = url;
  });
}

async function composeThumbnailStrip(
  results: ThumbnailRequestResult[],
  signal: AbortSignal,
  viewport: AssetRange,
  pixelWidth: number,
): Promise<Blob | undefined> {
  const images = await Promise.all(
    results.map(({ thumbnailURL }) =>
      thumbnailURL ? loadThumbnail(thumbnailURL, signal) : Promise.resolve(undefined),
    ),
  );
  if (signal.aborted) return undefined;
  images.forEach((image, index) => {
    if (results[index].thumbnailURL && !image) results[index].thumbnailFailed = true;
  });
  if (!images.some(Boolean)) return undefined;
  const tileHeight = Math.max(1, ...images.map((image) => image?.naturalHeight || 180));
  const canvas = document.createElement("canvas");
  canvas.width = pixelWidth;
  canvas.height = tileHeight;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  images.forEach((image, index) => {
    const range = results[index].range;
    const left = ((range.startMs - viewport.startMs) / viewport.durationMs) * canvas.width;
    const width = (range.durationMs / viewport.durationMs) * canvas.width;
    if (image) context.drawImage(image, left, 0, width, tileHeight);
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return signal.aborted ? undefined : (blob ?? undefined);
}

function readPreviewAsset(
  api: NativeMediaApiClient,
  mediaId: string,
  kind: "thumbnails" | "waveform",
  params: Record<string, number>,
): Effect.Effect<Blob, Error> {
  const onError = () =>
    new Error(`${kind === "thumbnails" ? "Thumbnail" : "Waveform"} request failed.`);
  return Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      const response = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async (signal) => {
            const response = await api.assetRequest(mediaId, kind, params, {
              signal: AbortSignal.any([signal, controller.signal]),
            });
            // A native transport may ignore abort and deliver headers after disposal.
            if (controller.signal.aborted || signal.aborted) {
              await response.body?.cancel().catch(() => undefined);
              throw onError();
            }
            return response;
          },
          catch: onError,
        }),
        (response) =>
          Effect.promise(async () => {
            controller.abort();
            await response.body?.cancel().catch(() => undefined);
          }),
        { interruptible: true },
      );
      if (!response.ok) return yield* Effect.fail(onError());
      if (!response.body) return new Blob();
      const chunks = yield* Stream.fromReadableStream({
        evaluate: () => response.body!,
        onError,
        releaseLockOnEnd: true,
      }).pipe(Stream.runCollect);
      return new Blob(
        Array.from(chunks, (chunk) => new Uint8Array(chunk)),
        {
          type: response.headers.get("Content-Type") ?? "",
        },
      );
    }),
  );
}

export function createPreviewAssets(
  server: ServerState,
  api: NativeMediaApiClient,
  selected: Atom.Atom<Media | undefined>,
) {
  const { runtime, registry } = server;
  const viewportIntent = Atom.keepAlive(
    Atom.make<{ mediaId: string | undefined; viewport: AssetViewport } | undefined>(undefined),
  );
  const reload = Atom.keepAlive(Atom.make(0));
  const viewportFor = (item: Media, intent: Atom.Type<typeof viewportIntent>) =>
    intent?.mediaId === item.id ? intent.viewport : { startMs: 0, endMs: item.durationMs };
  const thumbnail = Atom.keepAlive(
    runtime.atom((get) => {
      const item = get(selected);
      const intent = get(viewportIntent);
      get(reload);
      if (!item) return Effect.succeed(undefined);
      const viewport = viewportFor(item, intent);
      const fullRange = normalizedAssetViewport(viewport, item.durationMs);
      const ranges = visibleAssetRanges(viewport, item.durationMs);
      return Effect.gen(function* () {
        const urls = yield* Effect.acquireRelease(
          Effect.sync(() => new Set<string>()),
          (urls) => Effect.sync(() => urls.forEach((url) => URL.revokeObjectURL(url))),
        );
        const results = yield* Effect.all(
          ranges.map((range) =>
            Effect.gen(function* () {
              const blob = yield* readPreviewAsset(api, item.id, "thumbnails", {
                startMs: range.startMs,
                durationMs: range.durationMs,
                count: 16,
                width: 320,
              });
              const thumbnailURL = yield* Effect.try({
                try: () => {
                  const url = URL.createObjectURL(blob);
                  urls.add(url);
                  return url;
                },
                catch: () => new Error("Thumbnail could not be shown."),
              });
              return { range, thumbnailURL, thumbnailFailed: false };
            }).pipe(
              Effect.catch(() =>
                Effect.succeed<ThumbnailRequestResult>({ range, thumbnailFailed: true }),
              ),
            ),
          ),
          { concurrency: "unbounded" },
        );
        const combinedBlob = yield* Effect.tryPromise((signal) =>
          composeThumbnailStrip(results, signal, fullRange, assetPixelWidth(viewport)),
        ).pipe(Effect.catch(() => Effect.succeed(undefined)));
        const combinedThumbnail = yield* Effect.try({
          try: () => {
            if (combinedBlob) {
              const url = URL.createObjectURL(combinedBlob);
              urls.add(url);
              return url;
            }
            return results.find((result) => result.thumbnailURL)?.thumbnailURL;
          },
          catch: () => new Error("Thumbnail strip could not be shown."),
        }).pipe(
          Effect.catch(() =>
            Effect.succeed(results.find((result) => result.thumbnailURL)?.thumbnailURL),
          ),
        );
        return {
          thumbnailURL: combinedThumbnail,
          range: fullRange,
          failed: results.some((result) => result.thumbnailFailed),
        };
      });
    }),
  );
  const waveform = Atom.keepAlive(
    runtime.atom((get) => {
      const item = get(selected);
      const intent = get(viewportIntent);
      const visible = get(server.preferences.value).waveformVisible;
      get(reload);
      if (!item || !visible) return Effect.succeed(undefined);
      const viewport = viewportFor(item, intent);
      const ranges = visibleAssetRanges(viewport, item.durationMs);
      const fullRange = normalizedAssetViewport(viewport, item.durationMs);
      return Effect.gen(function* () {
        const results = yield* Effect.all(
          ranges.map((range) =>
            Effect.gen(function* () {
              const blob = yield* readPreviewAsset(api, item.id, "waveform", {
                startMs: range.startMs,
                durationMs: range.durationMs,
                samples: Math.max(
                  16,
                  Math.ceil((assetPixelWidth(viewport) * range.durationMs) / fullRange.durationMs),
                ),
              });
              const text = yield* Effect.tryPromise(() => blob.text());
              const value = yield* Effect.try({
                try: () => {
                  try {
                    return Schema.decodeUnknownSync(WaveformSchema)(JSON.parse(text));
                  } catch (cause) {
                    throw new Error("Waveform response is invalid.", { cause });
                  }
                },
                catch: (cause) => cause,
              });
              return { range, peaks: normalizePeaks(value.peaks), failed: false };
            }).pipe(
              Effect.catch(() => Effect.succeed({ range, peaks: [] as number[], failed: true })),
            ),
          ),
          { concurrency: "unbounded" },
        );
        const peaks = new Array<number>(assetPixelWidth(viewport)).fill(0);
        for (const result of results) {
          const first = Math.ceil(
            ((result.range.startMs - fullRange.startMs) / fullRange.durationMs) * peaks.length,
          );
          const last = Math.min(
            peaks.length,
            Math.floor(
              ((result.range.startMs + result.range.durationMs - fullRange.startMs) /
                fullRange.durationMs) *
                peaks.length,
            ),
          );
          for (let position = first; position < last; position++) {
            const sample = Math.floor(
              ((position - first) / Math.max(1, last - first)) * result.peaks.length,
            );
            peaks[position] = result.peaks[sample] ?? 0;
          }
        }
        return { peaks, failed: results.some((result) => result.failed) };
      });
    }),
  );
  const view = Atom.make((get) => {
    const thumbnails = get(thumbnail);
    const waves = get(waveform);
    // Native SWR retains old values while waiting; old-context URLs must not be rendered.
    const t = thumbnails.waiting ? undefined : Option.getOrUndefined(AsyncResult.value(thumbnails));
    const w = waves.waiting ? undefined : Option.getOrUndefined(AsyncResult.value(waves));
    const thumbnailFailed = AsyncResult.isFailure(thumbnails) || t?.failed;
    const waveformFailed = AsyncResult.isFailure(waves) || w?.failed;
    const status = [
      thumbnailFailed && "Thumbnails unavailable",
      waveformFailed && "Waveform unavailable",
    ]
      .filter(Boolean)
      .join("; ");
    const item = get(selected);
    const visibleRange = item ? viewportFor(item, get(viewportIntent)) : { startMs: 0, endMs: 0 };
    return {
      visibleRange,
      thumbnailURL: t?.thumbnailURL,
      assetRange: t?.range,
      waveform: w?.peaks ?? [],
      assetStatus: status ? `${status}; editing remains available.` : "",
    };
  });
  const viewportCommand = runtime.fn(
    (viewport: AssetViewport) =>
      Effect.sync(() =>
        registry.set(viewportIntent, { mediaId: registry.get(selected)?.id, viewport }),
      ),
    { concurrent: true },
  );
  const retry = runtime.fn(() => Effect.sync(() => registry.update(reload, (n) => n + 1)), {
    concurrent: true,
  });
  return {
    view,
    thumbnail,
    waveform,
    setViewport: (viewport: AssetViewport) => registry.set(viewportCommand, viewport),
    retry: () => registry.set(retry, undefined),
  };
}
