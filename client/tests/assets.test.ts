import { describe, expect, it } from "vitest";
import { normalizePeaks, viewportScale } from "../src/assets";

describe("timeline assets", () => {
  it("normalizes bounded waveform peaks", () => {
    expect(normalizePeaks([-1, 0.5, 2, "bad", Infinity])).toEqual([0, 0.5, 1]);
  });
  it("keeps viewport zoom bounded", () => {
    expect(viewportScale(0)).toBe(1);
    expect(viewportScale(40)).toBe(16);
  });
});
