import { describe, expect, it } from "vitest";
import { nextSegmentName, normalizeSegments, segmentIncluded } from "../src/features/preview/model";

describe("segment metadata", () => {
  it("defaults legacy segments to included and supplies stable identities", () => {
    const legacy = [{ startMs: 100, endMs: 300, label: "Opening" }];
    const first = normalizeSegments(legacy, "item-a");
    const second = normalizeSegments(legacy, "item-a");

    expect(first[0]).toMatchObject({
      id: second[0].id,
      startMs: 100,
      endMs: 300,
      label: "Opening",
      included: true,
    });
    expect(segmentIncluded(first[0])).toBe(true);
    expect(
      normalizeSegments(
        [
          { startMs: 400, endMs: 500 },
          { startMs: 100, endMs: 300 },
        ],
        "item-a",
      )[1].id,
    ).toBe(first[0].id);
  });

  it("chooses a monotonic collision-free default name", () => {
    expect(
      nextSegmentName([
        { id: "a", startMs: 0, endMs: 10, label: "Segment 001" },
        { id: "b", startMs: 20, endMs: 30, label: "Custom" },
        { id: "c", startMs: 40, endMs: 50, label: "Segment 004" },
      ]),
    ).toBe("Segment 005");
    expect(nextSegmentName([{ startMs: 0, endMs: 10, label: "Segment 001" }])).toBe("Segment 002");
    expect(nextSegmentName([{ startMs: 0, endMs: 10, label: "Segment 999" }])).toBe("Segment 1000");
  });

  it("keeps explicit exclusion and identity through normalization", () => {
    const segment = normalizeSegments(
      [{ id: "s_custom", startMs: 100, endMs: 300, included: false }],
      "item-a",
    )[0];

    expect(segment).toMatchObject({ id: "s_custom", included: false });
    expect(segmentIncluded(segment)).toBe(false);
  });
});
