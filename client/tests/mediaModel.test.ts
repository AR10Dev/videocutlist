import { describe, expect, it } from "vitest";
import { formatLibraryDuration, mediaSummary } from "../src/features/media/model";

describe("media explorer display", () => {
  it("formats durations with stable minute and hour fields", () => {
    expect(formatLibraryDuration(5_209)).toBe("00:05.209");
    expect(formatLibraryDuration(3_725_209)).toBe("01:02:05.209");
  });

  it("shows friendly video metadata without raw stream fields", () => {
    expect(
      mediaSummary({
        id: "opaque-id",
        name: "camera.mp4",
        durationMs: 5_209,
        sizeBytes: 1,
        container: "mp4",
        streams: { video: { codec: "h264", width: 854, height: 480 }, tracks: [{ index: 0 }] },
        etag: "etag",
      }),
    ).toBe("MP4 · H.264 · 854×480");
  });
});
