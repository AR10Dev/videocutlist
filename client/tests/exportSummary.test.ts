import { describe, expect, it } from "vitest";
import { exportRanges, summarizeExports } from "../src/features/export/summary";

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

  it("reports excluded counts and named filename previews", () => {
    const summary = summarizeExports([
      {
        id: "item-1",
        media: { name: "camera.mp4", durationMs: 1_000 },
        timeline: {
          present: {
            segments: [
              { id: "s_one", startMs: 100, endMs: 300, label: "Intro", included: true },
              { id: "s_two", startMs: 500, endMs: 700, label: "Discarded", included: false },
            ],
          },
        },
        exportOptions: {
          mode: "separate",
          selection: "segments",
          filenameTemplate: "{source}-{segment}.{ext}",
        },
      },
    ] as never);

    expect(summary[0]).toMatchObject({
      includedSegments: 1,
      excludedSegments: 1,
      outputs: 1,
      filenamePreviews: ["camera-Intro.mkv"],
    });
  });

  it("keeps an empty gaps workflow explicit instead of treating it as no output", () => {
    expect(exportRanges([], "gaps", 1_000)).toEqual([{ startMs: 0, endMs: 1_000 }]);
  });
});
