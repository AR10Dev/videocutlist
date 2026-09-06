import { describe, expect, it } from "vitest";
import {
  moveSegmentTo,
  resizeSegment,
  resizeSegmentInteractive,
  splitSegment,
} from "../src/features/editor/segmentEditing";

const segments = [
  { startMs: 100, endMs: 300, label: "A" },
  { startMs: 500, endMs: 700, label: "B" },
];

describe("saved cut editing", () => {
  it("clamps resizing without inverting a cut", () => {
    expect(resizeSegment(segments, 0, "start", 400, 1000)[0]).toEqual({
      startMs: 299,
      endMs: 300,
      label: "A",
    });
    expect(resizeSegment(segments, 0, "end", -10, 1000)[0]).toEqual({
      startMs: 100,
      endMs: 101,
      label: "A",
    });
  });

  it("clamps interactive boundaries to neighboring cuts", () => {
    expect(resizeSegmentInteractive(segments, 0, "end", 900, 1_000)[0]).toMatchObject({
      startMs: 100,
      endMs: 500,
    });
    expect(resizeSegmentInteractive(segments, 1, "start", -50, 1_000)[1]).toMatchObject({
      startMs: 300,
      endMs: 700,
    });
  });

  it("moves a cut while preserving duration and clamping to media", () => {
    expect(moveSegmentTo(segments, 0, -50, 1000)[0]).toEqual({
      startMs: 0,
      endMs: 200,
      label: "A",
    });
    expect(moveSegmentTo(segments, 1, 950, 1000)[1]).toEqual({
      startMs: 800,
      endMs: 1000,
      label: "B",
    });
  });

  it("rejects overlap and splits only inside the active cut", () => {
    expect(moveSegmentTo(segments, 0, 450, 1000)).toBe(segments);
    expect(splitSegment(segments, 0, 200)).toEqual([
      { startMs: 100, endMs: 200, label: "A" },
      { startMs: 200, endMs: 300, label: "A" },
      segments[1],
    ]);
    expect(splitSegment(segments, 0, 100)).toBe(segments);
  });
});
