import { describe, expect, it } from "vitest";
import { normalizePeaks, viewportScale, visibleAssetRange } from "../src/features/preview/assets";

describe("timeline assets", () => {
  it("normalizes bounded waveform peaks", () => {
    expect(normalizePeaks([-1, 0.5, 2, "bad", Infinity])).toEqual([0, 0.5, 1]);
  });
  it("keeps viewport zoom bounded", () => {
    expect(viewportScale(0)).toBe(1);
    expect(viewportScale(40)).toBe(16);
  });
  it("requests the visible interval instead of the media prefix", () => {
    expect(visibleAssetRange({ startMs: 180_000, endMs: 240_000 }, 600_000)).toEqual({
      startMs: 180_000,
      durationMs: 60_000,
    });
  });
  it("clamps a viewport at the media end and asset duration limit", () => {
    expect(visibleAssetRange({ startMs: 599_900, endMs: 700_000 }, 600_000)).toEqual({
      startMs: 599_900,
      durationMs: 100,
    });
    expect(visibleAssetRange({ startMs: 0, endMs: 600_000 }, 600_000)).toEqual({
      startMs: 0,
      durationMs: 120_000,
    });
  });
});
