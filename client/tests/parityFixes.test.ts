import { describe, expect, it } from "vitest";
import { moveSegment, removeSegment } from "../src/features/editor/segmentEditing";
import { frameDuration } from "../src/features/editor/frame";

describe("Solid parity editing helpers", () => {
  it("derives frame duration from video rate with a zero fallback", () => {
    expect(frameDuration({ streams: { video: { avgFrameRate: "25/1" } } } as never)).toBe(40);
    expect(frameDuration({ streams: { video: { avgFrameRate: "bad" } } } as never)).toBe(0);
    expect(frameDuration()).toBe(0);
  });

  it("reorders and removes labelled segments without mutating input", () => {
    const segments = [
      { startMs: 0, endMs: 100, label: "a" },
      { startMs: 200, endMs: 300, label: "b" },
    ];
    expect(moveSegment(segments, 1, -1).map((item) => item.label)).toEqual(["b", "a"]);
    expect(removeSegment(segments, 0)).toEqual([segments[1]]);
    expect(segments[0].label).toBe("a");
  });
});
