import { describe, expect, it } from "vitest";
import {
  acceptsMediaMetadata,
  parseTimecode,
  watchedMediaPosition,
  hybridSmartCutKnownIneligible,
} from "../src/preview";
import { validInterchangeFileSize } from "../src/api";
import { normalizePeaks, viewportScale } from "../src/assets";
import { moveSegment, removeSegment } from "../src/segmentEditing";
import { exportFailureMessage } from "../src/jobUi";
import { saveIsCurrent } from "../src/saveGuards";
import { frameDuration } from "../src/frame";

describe("Solid parity editing helpers", () => {
  it("parses only valid millisecond timecodes", () => {
    expect(parseTimecode("1:02.345")).toBe(62345);
    expect(parseTimecode("1:60.000")).toBeUndefined();
    expect(parseTimecode("bad")).toBeUndefined();
  });

  it("accepts only current, selected media metadata", () => {
    expect(acceptsMediaMetadata(false, 2, 2, "media-1", "media-1")).toBe(true);
    expect(acceptsMediaMetadata(false, 1, 2, "media-1", "media-1")).toBe(false);
    expect(acceptsMediaMetadata(true, 2, 2, "media-1", "media-1")).toBe(false);
    expect(acceptsMediaMetadata(false, 2, 2, "media-2", "media-1")).toBe(false);
  });

  it("uses watched preview time for marker placement", () => {
    expect(watchedMediaPosition(2000, 1.25, 10000)).toBe(3250);
  });

  it("normalizes bounded timeline assets independently of preview position", () => {
    expect(normalizePeaks([-.5, 0.5, 2, Number.NaN])).toEqual([0, 0.5, 1]);
    expect(viewportScale(4)).toBe(4);
    expect(viewportScale(0)).toBe(1);
  });

  it("derives frame duration from video rate with a zero fallback", () => {
    expect(frameDuration({ streams: { video: { avgFrameRate: "25/1" } } } as never)).toBe(40);
    expect(frameDuration({ streams: { video: { avgFrameRate: "bad" } } } as never)).toBe(0);
    expect(frameDuration()).toBe(0);
  });

  it("keeps interchange bounds and hybrid eligibility deterministic", () => {
    expect(validInterchangeFileSize(1 << 20)).toBe(true);
    expect(validInterchangeFileSize((1 << 20) + 1)).toBe(false);
    expect(hybridSmartCutKnownIneligible(undefined)).toBe(false);
  });

  it("does not clear dirty state after an edit during save", () => {
    expect(saveIsCurrent(false, 1, 1, 4, 3, "p", "p", "m", "m")).toBe(false);
    expect(saveIsCurrent(false, 1, 1, 3, 3, "p", "p", "m", "m")).toBe(true);
  });

  it("rejects save responses after the project or media context changes", () => {
    expect(saveIsCurrent(false, 1, 1, 3, 3, "old", "new", "m", "m")).toBe(false);
    expect(saveIsCurrent(false, 1, 1, 3, 3, "p", "p", "old-media", "new-media")).toBe(false);
    expect(saveIsCurrent(false, 1, 2, 3, 3, "p", "p", "m", "m")).toBe(false);
  });

  it("maps unsupported hybrid exports to actionable guidance", () => {
    expect(exportFailureMessage("hybrid_smart_cut_unsupported_media")).toContain("H.264 constant-frame-rate video in MKV");
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
