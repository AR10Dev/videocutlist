import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canStreamPreview,
  previewMime,
  validateSegments,
} from "../src/preview";

afterEach(() => vi.unstubAllGlobals());

describe("segment validation", () => {
  it("accepts ordered, non-overlapping integer millisecond segments", () => {
    expect(
      validateSegments(
        [
          { startMs: 0, endMs: 1000 },
          { startMs: 1000, endMs: 2000 },
        ],
        2000,
      ),
    ).toBeUndefined();
  });

  it("rejects invalid bounds and overlap before a project save", () => {
    expect(validateSegments([{ startMs: 1200, endMs: 1200 }], 2000)).toContain(
      "In before Out",
    );
    expect(
      validateSegments(
        [
          { startMs: 0, endMs: 1500 },
          { startMs: 1400, endMs: 2000 },
        ],
        2000,
      ),
    ).toContain("overlap");
  });
});

describe("MSE capability detection", () => {
  it("asks the browser about the exact fMP4 preview MIME", () => {
    const isTypeSupported = vi.fn(() => true);
    vi.stubGlobal("MediaSource", { isTypeSupported });
    expect(canStreamPreview()).toBe(true);
    expect(isTypeSupported).toHaveBeenCalledWith(previewMime);
  });
});
