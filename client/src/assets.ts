export type WaveformAsset = { startMs: number; durationMs: number; peaks: number[] };

export function normalizePeaks(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((peak): peak is number => typeof peak === "number" && Number.isFinite(peak)).map((peak) => Math.max(0, Math.min(1, peak)));
}

export function viewportScale(zoom: number): number {
  return Math.max(1, Math.min(16, Number.isFinite(zoom) ? zoom : 1));
}
