import type { Media } from "./preview";

export function frameDuration(media?: Media): number {
  const rate = media?.streams.video as { avgFrameRate?: unknown } | undefined;
  if (typeof rate?.avgFrameRate !== "string") return 0;
  const [numerator, denominator] = rate.avgFrameRate.split("/").map(Number);
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? Math.max(1, Math.round(1000 / fps)) : 0;
}
