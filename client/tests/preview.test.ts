import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canStreamPreview,
  formatTime,
  previewMime,
  streamPreview,
  validateSegments,
  watchedMediaPosition,
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

describe("preview positions", () => {
  it("formats clamped whole milliseconds at minute boundaries", () => {
    expect(formatTime(59_999, 60_000)).toBe("0:59.999");
    expect(formatTime(60_000, 60_000)).toBe("1:00.000");
    expect(formatTime(60_001, 60_000)).toBe("1:00.000");
  });

  it("maps watched preview time to media time and clamps it", () => {
    expect(watchedMediaPosition(1_000, 0.5, 2_000)).toBe(1_500);
    expect(watchedMediaPosition(1_000, 9, 2_000)).toBe(2_000);
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
    const stop = streamPreview(video, request, vi.fn(), vi.fn());
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

  it("reports request, read, and append failures but keeps cancellation silent", async () => {
    class FakeBuffer extends EventTarget {
      updating = false;
      appendBuffer = vi.fn(() => {
        throw new Error("append");
      });
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
    const video = {
      currentTime: 0,
      src: "",
      load: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
      removeAttribute: vi.fn(),
    } as unknown as HTMLVideoElement;
    const errors = vi.fn();
    streamPreview(video, () => Promise.resolve(new Response(null, { status: 500 })), vi.fn(), errors);
    instances[0].dispatchEvent(new Event("sourceopen"));
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: "Preview request failed. Try again." })));

    const readErrors = vi.fn();
    const badBody = { getReader: () => ({ read: () => Promise.reject(new Error("read")), cancel: vi.fn() }) } as unknown as ReadableStream<Uint8Array>;
    streamPreview(video, () => Promise.resolve({ ok: true, body: badBody, headers: new Headers() } as Response), vi.fn(), readErrors);
    instances[1].dispatchEvent(new Event("sourceopen"));
    await vi.waitFor(() => expect(readErrors).toHaveBeenCalledWith(expect.objectContaining({ message: "Preview data could not be read. Try again." })));

    const appendErrors = vi.fn();
    streamPreview(video, () => Promise.resolve(new Response(new Uint8Array([1]))), vi.fn(), appendErrors);
    instances[2].dispatchEvent(new Event("sourceopen"));
    await vi.waitFor(() => expect(appendErrors).toHaveBeenCalledWith(expect.objectContaining({ message: "Preview data could not be played. Try again." })));

    const cancelled = vi.fn();
    const stop = streamPreview(video, () => Promise.resolve(new Response(new Uint8Array([1]))), vi.fn(), cancelled);
    stop();
    instances[3].dispatchEvent(new Event("sourceopen"));
    await Promise.resolve();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("reports missing bodies and MSE setup failures", async () => {
    const instances: EventTarget[] = [];
    class FakeMediaSource extends EventTarget {
      readyState = "open";
      constructor() {
        super();
        instances.push(this);
      }
      addSourceBuffer() {
        throw new Error("unsupported");
      }
    }
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });
    const video = { load: vi.fn(), removeAttribute: vi.fn() } as unknown as HTMLVideoElement;
    const setupErrors = vi.fn();
    streamPreview(video, () => Promise.resolve(new Response(null)), vi.fn(), setupErrors);
    instances[0].dispatchEvent(new Event("sourceopen"));
    await vi.waitFor(() => expect(setupErrors).toHaveBeenCalledWith(expect.objectContaining({ message: "Preview is not supported by this browser." })));

    const bodyErrors = vi.fn();
    class BodyMediaSource extends EventTarget {
      readyState = "open";
      constructor() {
        super();
        instances.push(this);
      }
      addSourceBuffer() {
        return new EventTarget() as SourceBuffer;
      }
    }
    vi.stubGlobal("MediaSource", BodyMediaSource);
    streamPreview(video, () => Promise.resolve(new Response(null)), vi.fn(), bodyErrors);
    instances[1].dispatchEvent(new Event("sourceopen"));
    await vi.waitFor(() => expect(bodyErrors).toHaveBeenCalledWith(expect.objectContaining({ message: "Preview returned no playable data. Try again." })));
  });
});
