export type Media = {
  id: string;
  name: string;
  durationMs: number;
  sizeBytes: number;
  container: string;
  streams: Record<string, unknown>;
  etag: string;
};

export type Segment = { startMs: number; endMs: number; label?: string };
export type PreviewDiagnostics = {
  cache: string;
  requestId: string;
  startMs: number;
  durationMs: number;
  offsetMs: number;
  elapsedMs: number;
};

export const previewMime = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';

export const clampMediaPosition = (positionMs: number, durationMs: number) =>
  Math.max(0, Math.min(durationMs, Math.round(Number.isFinite(positionMs) ? positionMs : 0)));

export const formatTime = (positionMs: number, durationMs: number) => {
  const ms = clampMediaPosition(positionMs, durationMs);
  return `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
};

export const watchedMediaPosition = (
  previewStartMs: number,
  currentTimeSeconds: number,
  durationMs: number,
) => clampMediaPosition(previewStartMs + currentTimeSeconds * 1000, durationMs);

export function validateSegments(
  segments: Segment[],
  durationMs: number,
): string | undefined {
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs);
  for (let index = 0; index < ordered.length; index += 1) {
    const segment = ordered[index];
    if (!Number.isInteger(segment.startMs) || !Number.isInteger(segment.endMs))
      return "Markers use whole milliseconds.";
    if (
      segment.startMs < 0 ||
      segment.endMs > durationMs ||
      segment.startMs >= segment.endMs
    )
      return "Each segment must be inside the media and have In before Out.";
    if (index > 0 && ordered[index - 1].endMs > segment.startMs)
      return "Segments cannot overlap.";
  }
}

export function canStreamPreview() {
  return (
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported(previewMime)
  );
}

const headersToDiagnostics = (
  headers: Headers,
  elapsedMs: number,
): PreviewDiagnostics => ({
  cache: headers.get("X-Preview-Cache") ?? "unknown",
  requestId: headers.get("X-Request-ID") ?? "unknown",
  startMs: Number(headers.get("X-Preview-Start") ?? 0),
  durationMs: Number(headers.get("X-Preview-Duration") ?? 0),
  offsetMs: Number(headers.get("X-Preview-Offset") ?? 0),
  elapsedMs,
});

export function streamPreview(
  video: HTMLVideoElement,
  request: () => Promise<Response>,
  onDiagnostics: (diagnostics: PreviewDiagnostics) => void,
  onError: (error: Error) => void,
): () => void {
  let mediaSource: MediaSource;
  try {
    mediaSource = new MediaSource();
  } catch {
    onError(new Error("Preview is not supported by this browser."));
    return () => undefined;
  }
  let objectURL: string;
  try {
    objectURL = URL.createObjectURL(mediaSource);
  } catch {
    onError(new Error("Preview could not be started. Try again."));
    return () => undefined;
  }
  let sourceBuffer: SourceBuffer | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let disposed = false;
  let completed = false;
  let seekApplied = false;
  let failed = false;
  let previewOffsetMs = 0;
  const queued: Uint8Array[] = [];
  const clean = () => {
    if (disposed) return;
    disposed = true;
    void reader?.cancel();
    mediaSource.removeEventListener("sourceopen", open);
    sourceBuffer?.removeEventListener("updateend", updateEnd);
    sourceBuffer?.removeEventListener("error", sourceError);
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectURL);
  };
  const fail = (message: string) => {
    if (disposed || failed) return;
    failed = true;
    onError(new Error(message));
    clean();
  };
  const sourceError = () => fail("Preview data could not be played. Try again.");
  const appendNext = () => {
    if (disposed || !sourceBuffer || sourceBuffer.updating) return;
    if (queued.length === 0) {
      if (completed && mediaSource.readyState === "open") {
        try {
          mediaSource.endOfStream();
        } catch {
          fail("Preview could not be completed. Try again.");
        }
      }
      return;
    }
    try {
      sourceBuffer.appendBuffer(new Uint8Array(queued.shift()!).buffer);
    } catch {
      fail("Preview data could not be played. Try again.");
    }
  };
  const updateEnd = () => {
    if (!disposed && !seekApplied) {
      seekApplied = true;
      video.currentTime = previewOffsetMs / 1000;
      void video.play().catch(() => undefined);
    }
    appendNext();
  };
  const open = async () => {
    try {
      sourceBuffer = mediaSource.addSourceBuffer(previewMime);
      sourceBuffer.addEventListener("updateend", updateEnd);
      sourceBuffer.addEventListener("error", sourceError);
      const started = performance.now();
      const response = await request();
      if (!response.ok) {
        fail("Preview request failed. Try again.");
        return;
      }
      if (!response.body) {
        fail("Preview returned no playable data. Try again.");
        return;
      }
      const diagnostics = headersToDiagnostics(
        response.headers,
        Math.round(performance.now() - started),
      );
      onDiagnostics(diagnostics);
      previewOffsetMs = diagnostics.offsetMs;
      reader = response.body.getReader();
      while (!disposed) {
        const next = await reader.read();
        if (next.done) break;
        queued.push(next.value);
        appendNext();
      }
      completed = true;
      appendNext();
    } catch {
      fail(sourceBuffer ? "Preview data could not be read. Try again." : "Preview is not supported by this browser.");
    }
  };
  video.src = objectURL;
  mediaSource.addEventListener("sourceopen", open, { once: true });
  return clean;
}
