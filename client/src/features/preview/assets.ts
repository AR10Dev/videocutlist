export type AssetViewport = { startMs: number; endMs: number };
export type AssetRange = { startMs: number; durationMs: number };
export type WaveformAsset = AssetRange & { peaks: number[] };

export const maxAssetDurationMs = 120_000;

function normalizedViewport(viewport: AssetViewport, mediaDurationMs: number): AssetRange {
  const duration = Math.max(1, Math.round(Number.isFinite(mediaDurationMs) ? mediaDurationMs : 1));
  const start = Math.max(
    0,
    Math.min(duration - 1, Math.round(Number.isFinite(viewport.startMs) ? viewport.startMs : 0)),
  );
  const end = Math.max(
    start + 1,
    Math.min(duration, Math.round(Number.isFinite(viewport.endMs) ? viewport.endMs : duration)),
  );
  return { startMs: start, durationMs: end - start };
}

/** Returns the complete visible interval; requests may need to be tiled. */
export function visibleAssetRange(viewport: AssetViewport, mediaDurationMs: number): AssetRange {
  return normalizedViewport(viewport, mediaDurationMs);
}

/** Splits a visible interval into request-sized ranges without losing coverage. */
export function visibleAssetRanges(viewport: AssetViewport, mediaDurationMs: number): AssetRange[] {
  const visible = normalizedViewport(viewport, mediaDurationMs);
  const ranges: AssetRange[] = [];
  let startMs = visible.startMs;
  const endMs = visible.startMs + visible.durationMs;
  while (startMs < endMs) {
    const durationMs = Math.min(maxAssetDurationMs, endMs - startMs);
    ranges.push({ startMs, durationMs });
    startMs += durationMs;
  }
  return ranges;
}

export function normalizePeaks(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((peak): peak is number => typeof peak === "number" && Number.isFinite(peak))
    .map((peak) => Math.max(0, Math.min(1, peak)));
}

export function viewportScale(zoom: number): number {
  return Math.max(1, Math.min(16, Number.isFinite(zoom) ? zoom : 1));
}
