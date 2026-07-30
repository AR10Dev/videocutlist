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
  url: string,
  signal: AbortSignal,
  onDiagnostics: (diagnostics: PreviewDiagnostics) => void,
): () => void {
  const mediaSource = new MediaSource();
  const objectURL = URL.createObjectURL(mediaSource);
  let sourceBuffer: SourceBuffer | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let disposed = false;
  let completed = false;
  let seekApplied = false;
  let previewOffsetMs = 0;
  const queued: Uint8Array[] = [];
  const clean = () => {
    disposed = true;
    void reader?.cancel();
    mediaSource.removeEventListener("sourceopen", open);
    sourceBuffer?.removeEventListener("updateend", updateEnd);
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectURL);
  };
  const appendNext = () => {
    if (disposed || !sourceBuffer || sourceBuffer.updating) return;
    if (queued.length === 0) {
      if (completed && mediaSource.readyState === "open")
        mediaSource.endOfStream();
      return;
    }
    try {
      sourceBuffer.appendBuffer(new Uint8Array(queued.shift()!).buffer);
    } catch {
      clean();
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
      const started = performance.now();
      const response = await fetch(url, { signal });
      if (!response.ok || !response.body)
        throw new Error(`Preview request failed (${response.status}).`);
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
      // The caller owns status messaging; aborts are expected during scrubbing.
    }
  };
  video.src = objectURL;
  mediaSource.addEventListener("sourceopen", open, { once: true });
  return clean;
}
