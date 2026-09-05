import { describe, expect, it } from "vitest";
import {
  createProjectItem,
  moveProjectItem,
  restoreProjectItem,
  serializeProjectItem,
} from "../src/features/projects/model";
import type { components } from "../src/generated/api";

const media = (id: string, name: string): components["schemas"]["Media"] => ({
  id,
  name,
  durationMs: 10_000,
  sizeBytes: 1,
  container: "mp4",
  streams: {},
  etag: "v1",
});

describe("batch project items", () => {
  it("defaults new items to separate clips and carries a remembered destination", () => {
    const item = createProjectItem(media("m_first", "first.mp4"), "archive");
    expect(item.exportOptions).toMatchObject({ mode: "separate", destinationId: "archive" });
  });

  it("round-trips independent editor and export state", () => {
    const first = createProjectItem(media("m_first", "first.mp4"));
    first.timeline.present.playheadMs = 500;
    first.timeline.present.segments = [{ startMs: 100, endMs: 900 }];
    first.exportOptions.selection = "gaps";
    const saved = serializeProjectItem(first);
    const restored = restoreProjectItem(saved, first.media);
    expect(restored.timeline.present.playheadMs).toBe(500);
    expect(restored.timeline.present.segments).toEqual([{ startMs: 100, endMs: 900 }]);
    expect(restored.exportOptions.selection).toBe("gaps");
  });

  it("reorders without changing item identity", () => {
    const first = createProjectItem(media("m_first", "first.mp4"));
    const second = createProjectItem(media("m_second", "second.mp4"));
    expect(moveProjectItem([first, second], second.id, -1).map((item) => item.id)).toEqual([
      second.id,
      first.id,
    ]);
  });
});
