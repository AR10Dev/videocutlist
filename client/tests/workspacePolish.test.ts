import { describe, expect, it } from "vitest";
import { formatTime, parseTimecode } from "../src/features/preview/model";
import { parseProjectJson, projectJson } from "../src/features/projects/lifecycle";
import { createProjectItem, serializeProjectItem } from "../src/features/projects/model";
import { exportRanges, summarizeExports } from "../src/features/export/summary";

const media = {
  id: `m_${"a".repeat(43)}`,
  name: "camera.mp4",
  durationMs: 10000,
  sizeBytes: 1000,
  container: "mp4",
  streams: {},
  etag: "v1",
};

describe("polished workspace contracts", () => {
  it("accepts the hour timecodes the player formats without accepting overflow", () => {
    for (const value of [0, 1001, 3600000, 3661999])
      expect(parseTimecode(formatTime(value, value))).toBe(value);
    expect(parseTimecode("1:60:00.000")).toBeUndefined();
    expect(parseTimecode("99:99.000")).toBeUndefined();
    expect(parseTimecode("999999999999999999:00.000")).toBeUndefined();
  });
  it("round-trips the multi-item JSON that Download cut list produces", () => {
    const first = createProjectItem(media);
    const second = createProjectItem({ ...media, id: `m_${"b".repeat(43)}` });
    const document = {
      schemaVersion: 2,
      name: "Interview",
      revision: 1,
      items: [first, second].map(serializeProjectItem),
    };
    expect(parseProjectJson(projectJson(document))).toEqual(document);
    expect(() =>
      parseProjectJson(projectJson({ ...document, items: [document.items[0], document.items[0]] })),
    ).toThrow("invalid");
    expect(() =>
      parseProjectJson(
        projectJson({ ...document, items: [{ ...document.items[0], segments: [null] }] }),
      ),
    ).toThrow("invalid");
  });
  it("rejects paths and malformed imported export settings before requests", () => {
    const item = serializeProjectItem(createProjectItem(media));
    const document = { schemaVersion: 2, name: "Imported", items: [item] };
    for (const invalid of [
      { ...item, mediaId: "/private/original.mp4" },
      { ...item, exportOptions: { streamIndexes: "all" } },
      { ...item, exportOptions: { filenameTemplate: 5 } },
      { ...item, segments: [{ startMs: 0, endMs: 1000, label: {} }] },
    ])
      expect(() => parseProjectJson(JSON.stringify({ ...document, items: [invalid] }))).toThrow(
        "invalid",
      );
  });
  it("counts real per-item outputs and merged gap durations", () => {
    const first = createProjectItem(media);
    first.timeline.present.segments = [
      { startMs: 1000, endMs: 2000 },
      { startMs: 4000, endMs: 5000 },
    ];
    first.exportOptions = {
      mode: "separate",
      selection: "gaps",
      filenameTemplate: "{source}-{segment}.{ext}",
    };
    const second = createProjectItem({ ...media, name: "second.mp4" });
    second.timeline.present.segments = [{ startMs: 0, endMs: 1000 }];
    const result = summarizeExports([first, second]);
    expect(result[0]).toMatchObject({ outputs: 3, duration: 8000, filename: "camera-1.mkv" });
    expect(result[1]).toMatchObject({ outputs: 1, duration: 1000, filename: "second-1.mkv" });
    expect(summarizeExports([createProjectItem(media)])[0].outputs).toBe(0);
    expect(exportRanges([], "gaps", 10000)).toEqual([{ startMs: 0, endMs: 10000 }]);
    expect(
      exportRanges(
        [
          { startMs: 4000, endMs: 10000 },
          { startMs: 0, endMs: 5000 },
        ],
        "gaps",
        10000,
      ),
    ).toEqual([]);
  });
});
