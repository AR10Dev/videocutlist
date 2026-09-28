import { describe, expect, it, vi } from "vitest";
import { formatLibraryDuration, mediaSummary } from "../src/features/media/model";
import { createThumbnailObjectURL } from "../src/features/media/thumbnail";

describe("media explorer display", () => {
  it("formats durations with stable minute and hour fields", () => {
    expect(formatLibraryDuration(5_209)).toBe("00:05.209");
    expect(formatLibraryDuration(3_725_209)).toBe("01:02:05.209");
  });

  it("shows friendly video metadata without raw stream fields or container aliases", () => {
    const item = {
      id: "opaque-id",
      name: "camera.mp4",
      durationMs: 5_209,
      sizeBytes: 1,
      container: "mov,mp4",
      streams: { video: { codec: "h264", width: 854, height: 480 }, tracks: [{ index: 0 }] },
      etag: "etag",
    };
    expect(mediaSummary(item)).toBe("MP4 · H.264 · 854×480");
    expect(mediaSummary({ ...item, name: "camera.bin", container: "unknown,alias" })).toBe(
      "Video · H.264 · 854×480",
    );
    expect(mediaSummary({ ...item, name: "movie.mkv", container: "matroska,webm" })).toBe(
      "Matroska · H.264 · 854×480",
    );
    expect(mediaSummary({ ...item, name: "movie.webm", container: "matroska,webm" })).toBe(
      "WebM · H.264 · 854×480",
    );
  });

  it("does not allocate a thumbnail URL after the response blob is aborted", async () => {
    let resolveBlob!: (blob: Blob) => void;
    const response = {
      ok: true,
      blob: () =>
        new Promise<Blob>((resolve) => {
          resolveBlob = resolve;
        }),
    } as Response;
    const controller = new AbortController();
    const urlAPI = {
      createObjectURL: vi.fn(() => "blob:thumbnail"),
      revokeObjectURL: vi.fn(),
    };
    const pending = createThumbnailObjectURL(response, controller.signal, urlAPI);

    controller.abort();
    resolveBlob(new Blob(["thumbnail"], { type: "image/png" }));

    await expect(pending).resolves.toBeUndefined();
    expect(urlAPI.createObjectURL).not.toHaveBeenCalled();
    expect(urlAPI.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("revokes a thumbnail URL if abort lands during URL allocation", async () => {
    const controller = new AbortController();
    const urlAPI = {
      createObjectURL: vi.fn(() => {
        controller.abort();
        return "blob:thumbnail";
      }),
      revokeObjectURL: vi.fn(),
    };
    const response = new Response(new Blob(["thumbnail"], { type: "image/png" }));

    await expect(
      createThumbnailObjectURL(response, controller.signal, urlAPI),
    ).resolves.toBeUndefined();
    expect(urlAPI.createObjectURL).toHaveBeenCalledTimes(1);
    expect(urlAPI.revokeObjectURL).toHaveBeenCalledWith("blob:thumbnail");
  });
});
