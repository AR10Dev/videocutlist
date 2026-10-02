import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createPreviewController } from "../src/features/preview/controller";
import {
  canStreamPreview,
  formatTime,
  hybridSmartCutKnownIneligible,
  previewMime,
  previewRange,
  streamPreview,
  validateSegments,
  watchedMediaPosition,
} from "../src/features/preview/model";

afterEach(() => vi.unstubAllGlobals());

describe("hybrid Smart Cut eligibility", () => {
  const media = (video: Record<string, unknown>, overrides = {}) => ({
    id: "m1",
    name: "clip.mkv",
    durationMs: 1000,
    sizeBytes: 1,
    container: "matroska,webm",
    streams: { video },
    etag: "e1",
    ...overrides,
  });

  it("rejects known non-H.264, non-MKV, and VFR metadata", () => {
    expect(
      hybridSmartCutKnownIneligible(
        media({ codec: "hevc", avgFrameRate: "25/1", frameRate: "25/1" }),
      ),
    ).toBe(true);
    expect(
      hybridSmartCutKnownIneligible(
        media({ codec: "h264", avgFrameRate: "25/1", frameRate: "25/1" }, { name: "clip.webm" }),
      ),
    ).toBe(true);
    expect(
      hybridSmartCutKnownIneligible(
        media({ codec: "h264", avgFrameRate: "25/1", frameRate: "30/1" }),
      ),
    ).toBe(true);
  });

  it("does not disable when metadata is incomplete", () => {
    expect(hybridSmartCutKnownIneligible(media({ codec: "h264", avgFrameRate: "25/1" }))).toBe(
      false,
    );
  });
});

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
    expect(validateSegments([{ startMs: 1200, endMs: 1200 }], 2000)).toContain("In before Out");
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

describe("bounded playback ranges", () => {
  const segments = [
    { startMs: 4_000, endMs: 5_000 },
    { startMs: 900, endMs: 2_100 },
  ];

  it("uses exact active segment boundaries for once and loop modes", () => {
    expect(previewRange("active-segment", 10_000, segments[0])).toEqual({
      startMs: 4_000,
      endMs: 5_000,
    });
    expect(previewRange("active-segment-loop", 10_000, segments[0])).toEqual({
      startMs: 4_000,
      endMs: 5_000,
    });
  });

  it("keeps ordered preview in project segment order and falls back safely", () => {
    expect(previewRange("ordered-segments", 10_000, undefined, segments, 1)).toEqual({
      startMs: 900,
      endMs: 2_100,
    });
    expect(previewRange("ordered-segments", 10_000, undefined, [], 0)).toEqual({
      startMs: 0,
      endMs: 10_000,
    });
  });
});

describe("preview positions", () => {
  it("formats clamped whole milliseconds consistently through hours", () => {
    expect(formatTime(59_999, 60_000)).toBe("00:59.999");
    expect(formatTime(60_000, 60_000)).toBe("01:00.000");
    expect(formatTime(60_001, 60_000)).toBe("01:00.000");
    expect(formatTime(3_725_209, 4_000_000)).toBe("01:02:05.209");
  });

  it("maps watched preview time to media time and clamps it", () => {
    expect(watchedMediaPosition(1_000, 0.5, 2_000)).toBe(1_500);
    expect(watchedMediaPosition(1_000, 9, 2_000)).toBe(2_000);
  });
});

describe("preview waveform responses", () => {
  it("degrades malformed successful responses to the existing unavailable state", async () => {
    let controller!: ReturnType<typeof createPreviewController>;
    let dispose!: () => void;
    const [selected] = createSignal({
      id: "m_fixture",
      name: "fixture.mp4",
      durationMs: 10_000,
      sizeBytes: 1,
      container: "mp4",
      streams: {},
      etag: "fixture",
    });
    const [playhead] = createSignal(0);
    const [visibleRange] = createSignal({ startMs: 0, endMs: 10_000 });
    const api = {
      assetRequest: vi.fn((_id: string, kind: string) =>
        Promise.resolve(
          kind === "waveform"
            ? Response.json({ startMs: 0, durationMs: 10_000, peaks: "malformed" })
            : new Response(null, { status: 404 }),
        ),
      ),
      mediaRequest: vi.fn(),
    };
    createRoot((disposeRoot) => {
      dispose = disposeRoot;
      controller = createPreviewController(api as never, {
        selected,
        playheadMs: playhead,
        activeSegment: () => undefined,
        segments: () => [],
        visibleRange,
        updatePlaybackPosition: () => {},
      });
    });

    await vi.waitFor(() =>
      expect(controller.assetStatus()).toBe(
        "Thumbnails unavailable; Waveform unavailable; editing remains available.",
      ),
    );
    expect(controller.waveform()).toHaveLength(2048);
    expect(controller.waveform().every((peak) => peak === 0)).toBe(true);
    expect(api.assetRequest).toHaveBeenCalledWith(
      "m_fixture",
      "waveform",
      expect.any(Object),
      expect.any(Object),
    );
    dispose();
  });
});

describe("preview streaming", () => {
  it("waits until the requested offset is buffered before seeking without overriding pause", async () => {
    let bufferedEnd = 0;
    class FakeBuffer extends EventTarget {
      updating = false;
      appendBuffer = vi.fn();
      buffered = {
        get length() {
          return bufferedEnd > 0 ? 1 : 0;
        },
        start: () => 0,
        end: () => bufferedEnd,
      };
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
    const stop = streamPreview(video, request, vi.fn(), vi.fn(), () => false);
    instances[0].dispatchEvent(new Event("sourceopen"));
    await vi.waitFor(() => expect(source.appendBuffer).toHaveBeenCalledOnce());
    expect(video.currentTime).toBe(0);
    source.dispatchEvent(new Event("updateend"));
    expect(video.currentTime).toBe(0);
    bufferedEnd = 3;
    source.dispatchEvent(new Event("updateend"));
    expect(video.currentTime).toBe(1.234);
    expect(video.play).not.toHaveBeenCalled();
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
    streamPreview(
      video,
      () => Promise.resolve(new Response(null, { status: 500 })),
      vi.fn(),
      errors,
    );
    instances[0].dispatchEvent(new Event("sourceopen"));
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "Preview request failed. Try again. Timeline markers remain available for editing.",
        }),
      ),
    );

    const readErrors = vi.fn();
    const badBody = {
      getReader: () => ({
        read: () => Promise.reject(new Error("read")),
        cancel: () => Promise.resolve(),
      }),
    } as unknown as ReadableStream<Uint8Array>;
    streamPreview(
      video,
      () => Promise.resolve({ ok: true, body: badBody, headers: new Headers() } as Response),
      vi.fn(),
      readErrors,
    );
    instances[1].dispatchEvent(new Event("sourceopen"));
    await vi.waitFor(() =>
      expect(readErrors).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "Preview data could not be read. Try again. Timeline markers remain available for editing.",
        }),
      ),
    );

    const appendErrors = vi.fn();
    streamPreview(
      video,
      () => Promise.resolve(new Response(new Uint8Array([1]))),
      vi.fn(),
      appendErrors,
    );
    instances[2].dispatchEvent(new Event("sourceopen"));
    await vi.waitFor(() =>
      expect(appendErrors).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "Preview data could not be played. Try again. Timeline markers remain available for editing.",
        }),
      ),
    );

    const cancelled = vi.fn();
    const stop = streamPreview(
      video,
      () => Promise.resolve(new Response(new Uint8Array([1]))),
      vi.fn(),
      cancelled,
    );
    stop();
    instances[3].dispatchEvent(new Event("sourceopen"));
    await Promise.resolve();
    expect(cancelled).not.toHaveBeenCalled();

    // Aborting fetch errors the body before the component cancels its reader.
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    const diagnostics = vi.fn();
    const abortErrors = vi.fn();
    const stopAborted = streamPreview(
      video,
      () => Promise.resolve(new Response(body)),
      diagnostics,
      abortErrors,
    );
    instances[4].dispatchEvent(new Event("sourceopen"));
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledOnce());
    bodyController.error(new DOMException("Fetch aborted", "AbortError"));
    stopAborted();
    await Promise.resolve();
    expect(abortErrors).not.toHaveBeenCalled();
  });

  it("silently cancels a body returned by an uncooperative request after teardown", async () => {
    const sources: EventTarget[] = [];
    const sourceBuffer = new EventTarget();
    class FakeMediaSource extends EventTarget {
      constructor() {
        super();
        sources.push(this);
      }
      addSourceBuffer() {
        return sourceBuffer as SourceBuffer;
      }
    }
    vi.stubGlobal("MediaSource", FakeMediaSource);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL,
    });
    const video = {
      src: "",
      load: vi.fn(),
      removeAttribute: vi.fn(),
    } as unknown as HTMLVideoElement;
    let release!: (response: Response) => void;
    const request = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const cancel = vi.fn();
    const diagnostics = vi.fn();
    const errors = vi.fn();
    const stop = streamPreview(video, request, diagnostics, errors);
    sources[0].dispatchEvent(new Event("sourceopen"));
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    stop();
    release(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    });
    expect(diagnostics).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("does not detach a newer preview when an old media scope finishes cleanup", async () => {
    class FakeMediaSource extends EventTarget {}
    vi.stubGlobal("MediaSource", FakeMediaSource);
    let sequence = 0;
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => `blob:preview-${++sequence}`),
      revokeObjectURL,
    });
    const video = {
      src: "",
      load: vi.fn(),
      removeAttribute: vi.fn(),
    } as unknown as HTMLVideoElement;
    const stopFirst = streamPreview(
      video,
      () => Promise.resolve(new Response(null)),
      vi.fn(),
      vi.fn(),
    );
    const stopSecond = streamPreview(
      video,
      () => Promise.resolve(new Response(null)),
      vi.fn(),
      vi.fn(),
    );
    stopFirst();
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-1"));
    expect(video.src).toBe("blob:preview-2");
    expect(video.removeAttribute).not.toHaveBeenCalled();
    stopSecond();
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-2"));
    expect(video.removeAttribute).toHaveBeenCalledWith("src");
  });

  it.each(["from diagnostics", "failed response"])(
    "releases response bodies when teardown happens %s",
    async (scenario) => {
      const sources: EventTarget[] = [];
      class FakeMediaSource extends EventTarget {
        readyState = "open";
        constructor() {
          super();
          sources.push(this);
        }
        addSourceBuffer() {
          return new EventTarget() as SourceBuffer;
        }
        endOfStream() {}
      }
      vi.stubGlobal("MediaSource", FakeMediaSource);
      vi.stubGlobal("URL", {
        createObjectURL: vi.fn(() => "blob:preview"),
        revokeObjectURL: vi.fn(),
      });
      const video = { load: vi.fn(), removeAttribute: vi.fn() } as unknown as HTMLVideoElement;
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const response = Promise.resolve(
        new Response(body, { status: scenario === "failed response" ? 500 : 200 }),
      );
      const errors = vi.fn();
      const diagnostics = vi.fn(() => {
        if (scenario === "from diagnostics") stop();
      });
      const stop = streamPreview(video, () => response, diagnostics, errors);
      sources[0].dispatchEvent(new Event("sourceopen"));

      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(diagnostics).toHaveBeenCalledTimes(scenario === "from diagnostics" ? 1 : 0);
      if (scenario === "failed response") {
        expect(errors).toHaveBeenCalledWith(
          expect.objectContaining({
            message:
              "Preview request failed. Try again. Timeline markers remain available for editing.",
          }),
        );
      } else {
        expect(errors).not.toHaveBeenCalled();
      }
    },
  );

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
    await vi.waitFor(() =>
      expect(setupErrors).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Preview is not supported by this browser." }),
      ),
    );

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
    await vi.waitFor(() =>
      expect(bodyErrors).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "Preview returned no playable data. Try again. Timeline markers remain available for editing.",
        }),
      ),
    );
  });
});
