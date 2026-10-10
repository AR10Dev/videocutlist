import type { NativeMediaApiClient } from "../../api";
import type * as EffectApiTypes from "../../generated/effect-api";
import { Cause, Effect } from "effect";

export type Media = EffectApiTypes.Media;

type VideoMetadata = {
  codec?: unknown;
  avgFrameRate?: unknown;
  frameRate?: unknown;
};

const frameRate = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0 ||
    numerator <= 0
  )
    return undefined;
  return numerator / denominator;
};

export const hybridSmartCutKnownIneligible = (media?: Media) => {
  if (!media) return false;
  const video = media.streams.video as VideoMetadata | undefined;
  if (!video || typeof video.codec !== "string") return false;
  if (video.codec.toLowerCase() !== "h264") return true;
  if (
    media.container.toLowerCase() !== "matroska,webm" ||
    !media.name.toLowerCase().endsWith(".mkv")
  )
    return true;
  const average = frameRate(video.avgFrameRate);
  const nominal = frameRate(video.frameRate);
  return average !== undefined && nominal !== undefined && average !== nominal;
};

export type Segment = EffectApiTypes.Project["items"][number]["segments"][number];

export const MAX_SEGMENT_LABEL_CODEPOINTS = 200;

export const segmentLabelCodePointCount = (label: string) => Array.from(label).length;

export const validateSegmentLabel = (label: string): string | undefined =>
  segmentLabelCodePointCount(label) > MAX_SEGMENT_LABEL_CODEPOINTS
    ? `Segment labels must be ${MAX_SEGMENT_LABEL_CODEPOINTS} Unicode characters or fewer.`
    : undefined;

export const segmentIncluded = (segment: Segment) => segment.included !== false;

export const newSegmentId = () => {
  const randomUUID = globalThis.crypto?.randomUUID?.();
  if (randomUUID) return `s_${randomUUID.replaceAll("-", "")}`;
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
};

const defaultSegmentName = /^Segment (\d+)$/;

/** Return the next collision-free default name for one media item's segments. */
export const nextSegmentName = (segments: Segment[]) => {
  const names = new Set(
    segments.flatMap((segment) => (typeof segment.label === "string" ? [segment.label] : [])),
  );
  let largest = 0;
  for (const name of names) {
    const match = defaultSegmentName.exec(name);
    if (match) largest = Math.max(largest, Number(match[1]));
  }
  let number = largest + 1;
  let name = `Segment ${String(number).padStart(3, "0")}`;
  while (names.has(name)) {
    number += 1;
    name = `Segment ${String(number).padStart(3, "0")}`;
  }
  return name;
};

const legacySegmentId = (scope: string, segment: Segment) => {
  let hash = 2166136261;
  const value = `${scope}:${segment.startMs}:${segment.endMs}`;
  for (let position = 0; position < value.length; position += 1) {
    hash ^= value.charCodeAt(position);
    hash = Math.imul(hash, 16777619);
  }
  return `s_legacy_${(hash >>> 0).toString(36)}`;
};

/** Add browser metadata while keeping old project segments readable. */
export const normalizeSegments = (segments: Segment[], scope = "media") => {
  const used = new Set<string>();
  return segments.map((segment, index) => {
    let id = segment.id || legacySegmentId(scope, segment);
    if (used.has(id)) id = `${id}_${index.toString(36)}`;
    used.add(id);
    return { ...segment, id, included: segmentIncluded(segment) };
  });
};

export type PreviewDiagnostics = {
  cache: string;
  requestId: string;
  startMs: number;
  durationMs: number;
  offsetMs: number;
  elapsedMs: number;
};

export type PreviewPlaybackMode =
  | "whole-media"
  | "active-segment"
  | "active-segment-loop"
  | "ordered-segments";

export type PreviewRange = { startMs: number; endMs: number };

export const previewRange = (
  mode: PreviewPlaybackMode,
  durationMs: number,
  activeSegment?: Segment,
  segments: Segment[] = [],
  orderedIndex = 0,
): PreviewRange => {
  if (mode === "whole-media") return { startMs: 0, endMs: durationMs };
  if (mode === "active-segment" || mode === "active-segment-loop")
    return activeSegment
      ? { startMs: activeSegment.startMs, endMs: activeSegment.endMs }
      : { startMs: 0, endMs: durationMs };
  const segment = segments[orderedIndex];
  return segment
    ? { startMs: segment.startMs, endMs: segment.endMs }
    : { startMs: 0, endMs: durationMs };
};

export const previewMime = 'video/mp4; codecs="avc1.42C01F, mp4a.40.2"';

export const clampMediaPosition = (positionMs: number, durationMs: number) =>
  Math.max(0, Math.min(durationMs, Math.round(Number.isFinite(positionMs) ? positionMs : 0)));

export const parseTimecode = (value: string) => {
  const match = /^(?:(\d+):)?(\d+):(\d{2})\.(\d{3})$/.exec(value.trim());
  if (!match || Number(match[3]) > 59 || (match[1] !== undefined && Number(match[2]) > 59))
    return undefined;
  const ms =
    Number(match[1] ?? 0) * 3600000 +
    Number(match[2]) * 60000 +
    Number(match[3]) * 1000 +
    Number(match[4]);
  return Number.isSafeInteger(ms) ? ms : undefined;
};

export const formatTime = (positionMs: number, durationMs: number) => {
  const ms = clampMediaPosition(positionMs, durationMs);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms / 60_000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
};

export const watchedMediaPosition = (
  previewStartMs: number,
  currentTimeSeconds: number,
  durationMs: number,
) => clampMediaPosition(previewStartMs + currentTimeSeconds * 1000, durationMs);

export function validateSegments(segments: Segment[], durationMs: number): string | undefined {
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs);
  for (let index = 0; index < ordered.length; index += 1) {
    const segment = ordered[index];
    if (typeof segment.label === "string") {
      const labelError = validateSegmentLabel(segment.label);
      if (labelError) return labelError;
    }
    if (!Number.isInteger(segment.startMs) || !Number.isInteger(segment.endMs))
      return "Markers use whole milliseconds.";
    if (segment.startMs < 0 || segment.endMs > durationMs || segment.startMs >= segment.endMs)
      return "Each segment must be inside the media and have In before Out.";
    if (index > 0 && ordered[index - 1].endMs > segment.startMs) return "Segments cannot overlap.";
  }
}

export function canStreamPreview() {
  return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(previewMime);
}

const headersToDiagnostics = (headers: Headers, elapsedMs: number): PreviewDiagnostics => ({
  cache: headers.get("X-Preview-Cache") ?? "unknown",
  requestId: headers.get("X-Request-ID") ?? "unknown",
  startMs: Number(headers.get("X-Preview-Start") ?? 0),
  durationMs: Number(headers.get("X-Preview-Duration") ?? 0),
  offsetMs: Number(headers.get("X-Preview-Offset") ?? 0),
  elapsedMs,
});

/** Native events report facts; observing position never issues a native seek or play. */
export function observePreviewPlayer(
  player: HTMLVideoElement,
  observe: (
    event: "position" | "ended" | "playing" | "pause" | "ready" | "emptied" | "error" | "waiting",
  ) => void,
) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      let active = true;
      let seeking = false;
      const listeners: Array<[string, EventListener]> = [];
      const listen = (name: string, f: () => void) => {
        const listener = () => {
          if (active) f();
        };
        player.addEventListener(name, listener);
        listeners.push([name, listener]);
      };
      listen("seeking", () => {
        seeking = true;
      });
      listen("seeked", () => {
        seeking = false;
      });
      listen("timeupdate", () => {
        if (!seeking) observe("position");
      });
      for (const event of ["ended", "playing", "pause", "emptied", "error", "waiting"] as const) {
        listen(event, () => observe(event));
      }
      listen("loadeddata", () => observe("ready"));
      return () => {
        active = false;
        listeners.forEach(([name, listener]) => player.removeEventListener(name, listener));
      };
    }),
    (release) => Effect.sync(release),
  );
}

/** Authenticated native preview transport; the stream scope supplies cancellation. */
export const previewMediaRequest =
  (api: NativeMediaApiClient, mediaId: string, params: URLSearchParams) => (signal: AbortSignal) =>
    api.mediaRequest(`media/${encodeURIComponent(mediaId)}/preview?${params}`, { signal });

/** The workspace stream scope owns this adapter. Disposing it releases the reader, MSE listeners and URL. */
export function streamPreview(
  video: HTMLVideoElement,
  request: (signal: AbortSignal) => Promise<Response>,
  onDiagnostics: (diagnostics: PreviewDiagnostics) => void,
  onError: (error: Error) => void,
  shouldPlay: () => boolean = () => true,
): Effect.Effect<void, never, import("effect/Scope").Scope> {
  const failure = (message: string) =>
    new Error(
      message.includes("not supported")
        ? message
        : `${message} Timeline markers remain available for editing.`,
    );
  let disposed = false;
  return Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        disposed = true;
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const mediaSource = yield* Effect.try({
          try: () => new MediaSource(),
          catch: () => failure("Preview is not supported by this browser."),
        });
        const objectURL = yield* Effect.acquireRelease(
          Effect.try({
            try: () => URL.createObjectURL(mediaSource),
            catch: () => failure("Preview could not be started. Try again."),
          }),
          (objectURL) =>
            Effect.sync(() => {
              if (video.src === objectURL) {
                video.removeAttribute("src");
                video.load();
              }
              URL.revokeObjectURL(objectURL);
            }),
        );
        yield* Effect.try({
          try: () => {
            video.src = objectURL;
          },
          catch: () => failure("Preview could not be started. Try again."),
        });
        const sourceBuffer = yield* Effect.callback<SourceBuffer, Error>((resume) => {
          const open = () => {
            try {
              resume(Effect.succeed(mediaSource.addSourceBuffer(previewMime)));
            } catch {
              resume(Effect.fail(failure("Preview is not supported by this browser.")));
            }
          };
          mediaSource.addEventListener("sourceopen", open, { once: true });
          return Effect.sync(() => mediaSource.removeEventListener("sourceopen", open));
        });
        let completed = false;
        let seekApplied = false;
        let previewOffsetMs = 0;
        const queued: Uint8Array<ArrayBuffer>[] = [];
        let signalFailure: (message: string) => void = () => undefined;
        const appendNext = () => {
          if (disposed || sourceBuffer.updating) return;
          if (queued.length === 0) {
            if (completed && mediaSource.readyState === "open") {
              try {
                mediaSource.endOfStream();
              } catch {
                signalFailure("Preview could not be completed. Try again.");
              }
            }
            return;
          }
          try {
            sourceBuffer.appendBuffer(queued.shift()!);
          } catch {
            signalFailure("Preview data could not be played. Try again.");
          }
        };
        const updateEnd = () => {
          if (disposed) return;
          if (!seekApplied) {
            const target = previewOffsetMs / 1000;
            const buffered = sourceBuffer.buffered;
            for (let index = 0; !buffered || index < buffered.length; index += 1) {
              if (!buffered || (buffered.start(index) <= target && target <= buffered.end(index))) {
                seekApplied = true;
                video.currentTime = target;
                if (shouldPlay())
                  void video.play().catch(() => {
                    if (!disposed)
                      onError(
                        failure(
                          "Playback could not start. Wait for the preview to load and try again.",
                        ),
                      );
                  });
                break;
              }
            }
          }
          appendNext();
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            sourceBuffer.addEventListener("updateend", updateEnd);
            sourceBuffer.addEventListener("error", sourceError);
          }),
          () =>
            Effect.sync(() => {
              sourceBuffer.removeEventListener("updateend", updateEnd);
              sourceBuffer.removeEventListener("error", sourceError);
            }),
        );
        function sourceError() {
          signalFailure("Preview data could not be played. Try again.");
        }
        const streaming = Effect.gen(function* () {
          const started = performance.now();
          // Some request implementations ignore abortion. Their late bodies still need disposal.
          const response = yield* Effect.tryPromise({
            try: async (signal) => {
              const response = await request(signal);
              if (disposed || signal.aborted) await response.body?.cancel().catch(() => undefined);
              return response;
            },
            catch: () => failure("Preview data could not be read. Try again."),
          });
          const reader = yield* Effect.acquireRelease(
            Effect.sync(() => response.body?.getReader()),
            (reader) =>
              Effect.promise(async () => {
                if (!reader) return;
                await reader.cancel().catch(() => undefined);
                reader.releaseLock();
              }),
          );
          if (!response.ok)
            return yield* Effect.fail(failure("Preview request failed. Try again."));
          if (!reader)
            return yield* Effect.fail(failure("Preview returned no playable data. Try again."));
          const diagnostics = headersToDiagnostics(
            response.headers,
            Math.round(performance.now() - started),
          );
          previewOffsetMs = diagnostics.offsetMs;
          if (!disposed) onDiagnostics(diagnostics);
          while (true) {
            const next = yield* Effect.tryPromise({
              try: () => reader.read(),
              catch: () => failure("Preview data could not be read. Try again."),
            });
            if (next.done) break;
            queued.push(next.value);
            appendNext();
          }
          completed = true;
          appendNext();
          return yield* Effect.never;
        });
        const failureEvents = Effect.callback<never, Error>((resume) => {
          signalFailure = (message) => resume(Effect.fail(failure(message)));
          return Effect.sync(() => {
            signalFailure = () => undefined;
          });
        });
        return yield* Effect.raceFirst(streaming, failureEvents);
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (!disposed && !Cause.hasInterrupts(cause)) {
            const error = Cause.squash(cause);
            onError(
              error instanceof Error
                ? error
                : failure("Preview data could not be read. Try again."),
            );
          }
        }),
      ),
    );
  });
}
