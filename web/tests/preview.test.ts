import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canStreamPreview,
  previewMime,
  streamPreview,
  validateSegments,
} from "../src/preview";

afterEach(() => vi.unstubAllGlobals());

describe("segment validation", () => {
  it("accepts ordered, non-overlapping integer millisecond segments", () => {
    expect(
      validateSegments(
        [
          { startMs: 0, endMs: 1000 },
          { startMs: 1000, endMs: 2000 },
        ],
        2000,
      ),
    ).toBeUndefined();
  });

  it("rejects invalid bounds and overlap before a project save", () => {
    expect(validateSegments([{ startMs: 1200, endMs: 1200 }], 2000)).toContain(
      "In before Out",
    );
    expect(
      validateSegments(
        [
          { startMs: 0, endMs: 1500 },
          { startMs: 1400, endMs: 2000 },
        ],
        2000,
      ),
    ).toContain("overlap");
  });
});

describe("MSE capability detection", () => {
  it("asks the browser about the exact fMP4 preview MIME", () => {
    const isTypeSupported = vi.fn(() => true);
    vi.stubGlobal("MediaSource", { isTypeSupported });
    expect(canStreamPreview()).toBe(true);
    expect(isTypeSupported).toHaveBeenCalledWith(previewMime);
  });
});

describe("preview streaming", () => {
  it("seeks only after the first SourceBuffer append completes", async () => {
    class FakeBuffer extends EventTarget {
      updating = false;
      appendBuffer = vi.fn();
    }
    const source = new FakeBuffer();
    const instances: EventTarget[] = [];
    class FakeMediaSource extends EventTarget {
      readyState = "open";
      constructor() {
        super();
        instances.push(this);
      }
      addSourceBuffer() {
        return source as unknown as SourceBuffer;
      }
      endOfStream() {}
    }
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const request = vi.fn(() =>
      Promise.resolve(
        new Response(new Uint8Array([1]), {
          headers: { "X-Preview-Offset": "1234" },
        }),
      ),
    );
    const video = {
      currentTime: 0,
      src: "",
      load: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
      removeAttribute: vi.fn(),
    } as unknown as HTMLVideoElement;
    const stop = streamPreview(video, request, vi.fn());
    instances[0].dispatchEvent(new Event("sourceopen"));
    await vi.waitFor(() => expect(source.appendBuffer).toHaveBeenCalledOnce());
    expect(video.currentTime).toBe(0);
    source.dispatchEvent(new Event("updateend"));
    expect(video.currentTime).toBe(1.234);
    expect(video.play).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    stop();
  });
});
