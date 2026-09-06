import { describe, expect, it } from "vitest";
import { exportRanges } from "../src/features/export/summary";

describe("export range inclusion", () => {
  it("omits excluded ranges from selected exports while preserving gaps", () => {
    const segments = [
      { id: "s_one", startMs: 100, endMs: 300, included: true },
      { id: "s_two", startMs: 500, endMs: 700, included: false },
    ];

    expect(exportRanges(segments, "segments", 1_000)).toEqual([segments[0]]);
    expect(exportRanges(segments, "gaps", 1_000)).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 300, endMs: 1_000 },
    ]);
  });
});
