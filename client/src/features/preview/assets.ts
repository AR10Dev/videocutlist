export type AssetViewport = { startMs: number; endMs: number; widthPx?: number };
export type AssetRange = { startMs: number; durationMs: number };

export const maxAssetDurationMs = 120_000;

export function normalizedAssetViewport(
  viewport: AssetViewport,
  mediaDurationMs: number,
): AssetRange {
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

/** Samples the visible interval within a render-width-derived, fixed work budget. */
export function visibleAssetRanges(viewport: AssetViewport, mediaDurationMs: number): AssetRange[] {
  const visible = normalizedAssetViewport(viewport, mediaDurationMs);
  const width = Number.isFinite(viewport.widthPx) ? Math.max(1, viewport.widthPx ?? 1) : 960;
  const budget = Math.max(1, Math.min(8, Math.ceil(width / 320)));
  const count = Math.min(budget, Math.ceil(visible.durationMs / maxAssetDurationMs));
  if (visible.durationMs <= count * maxAssetDurationMs) {
    return Array.from({ length: count }, (_, index) => ({
      startMs: visible.startMs + index * maxAssetDurationMs,
      durationMs: Math.min(maxAssetDurationMs, visible.durationMs - index * maxAssetDurationMs),
    }));
  }
  const sampleDuration = Math.min(maxAssetDurationMs, visible.durationMs);
  if (count === 1) return [{ startMs: visible.startMs, durationMs: sampleDuration }];
  const lastStart = visible.startMs + visible.durationMs - sampleDuration;
  return Array.from({ length: count }, (_, index) => ({
    startMs: Math.round(visible.startMs + ((lastStart - visible.startMs) * index) / (count - 1)),
    durationMs: sampleDuration,
  }));
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
