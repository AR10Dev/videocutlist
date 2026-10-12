import { RegistryContext } from "@effect/atom-solid";
import { Effect, Fiber } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createServerState } from "../src/app/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal, createComponent } from "solid-js";
import type * as EffectApiTypes from "../src/generated/effect-api";
import { createPreviewController } from "../src/features/preview/controller";
import { defaultBrowserPreferences } from "../src/features/settings/model";
import {
  canStreamPreview,
  formatTime,
  hybridSmartCutKnownIneligible,
  previewMime,
  previewRange,
  streamPreview as streamPreviewEffect,
  validateSegments,
  watchedMediaPosition,
} from "../src/features/preview/model";

const streamPreview = (...args: Parameters<typeof streamPreviewEffect>) => {
  const fiber = Effect.runFork(Effect.scoped(streamPreviewEffect(...args)));
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
};

afterEach(() => vi.unstubAllGlobals());

describe("hybrid Smart Cut eligibility", () => {
  const media = (
    video: { codec?: string; avgFrameRate?: string; frameRate?: string },
    overrides: Partial<EffectApiTypes.Media> = {},
  ): EffectApiTypes.Media => ({
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
    expect(hybridSmartCutKnownIneligible(undefined)).toBe(false);
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

    let preferences = { ...defaultBrowserPreferences };
    const savedPreferences: Array<Partial<typeof defaultBrowserPreferences>> = [];
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
    const registry = AtomRegistry.make();
    const server = createServerState(api as never, registry, {
      serverBaseUrl: "http://localhost",
      authentication: { type: "none" },
    });
    createRoot((disposeRoot) => {
      dispose = () => {
        disposeRoot();
        registry.dispose();
      };
      controller = createPreviewController(api as never, {
        server,
        selectedAtom: Atom.make(selected()),
        selected,
        playheadMs: playhead,
        activeSegment: () => undefined,
        segments: () => [],
        preferences: () => preferences,
        savePreferences: (changes) => {
          savedPreferences.push(changes);
          preferences = { ...preferences, ...changes };
        },
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
    controller.setWaveformVisibility(false);
    controller.setLoopSelectedSegment(true);
    expect(controller.waveformVisible()).toBe(false);
    expect(controller.loopSelectedSegment()).toBe(true);
    expect(savedPreferences).toEqual([{ waveformVisible: false }, { loopSelectedSegment: true }]);
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
    const response = new Response(new Uint8Array([1]), {
      headers: { "X-Preview-Offset": "1234" },
    });
    const request = vi.fn(() => Promise.resolve(response));
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
    expect(response.body!.locked).toBe(true);
    stop();
    await vi.waitFor(() => expect(response.body!.locked).toBe(false));
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
    const badBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("read"));
      },
    });
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

    expect(badBody.locked).toBe(false);

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

      await vi.waitFor(() => {
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
      });
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

describe("workspace playback observations", () => {
  function setup() {
    const sources: EventTarget[] = [];
    class Buffer extends EventTarget {
      updating = false;
      buffered = { length: 1, start: () => 0, end: () => 8 };
      appendBuffer() {}
    }
    const buffers: Buffer[] = [];
    class Source extends EventTarget {
      static isTypeSupported() {
        return true;
      }
      readyState = "open";
      constructor() {
        super();
        sources.push(this);
      }
      addSourceBuffer() {
        const buffer = new Buffer();
        buffers.push(buffer);
        return buffer;
      }
      endOfStream() {}
    }
    vi.stubGlobal("MediaSource", Source);
    let url = 0;
    const revoke = vi.fn();
    class PreviewURL extends URL {
      static createObjectURL() {
        return `blob:preview-${++url}`;
      }
      static revokeObjectURL = revoke;
    }
    vi.stubGlobal("URL", PreviewURL);
    class Player extends EventTarget {
      src = "";
      currentTime = 0;
      paused = true;
      ended = false;
      readyState = 0;
      play = vi.fn(() => Promise.resolve());
      pause = vi.fn(() => {
        this.paused = true;
        this.dispatchEvent(new Event("pause"));
      });
      load = vi.fn();
      removeAttribute = vi.fn();
    }
    const player = new Player();
    const selected = Atom.keepAlive(
      Atom.make<EffectApiTypes.Media | undefined>({
        id: "m1",
        name: "clip.mp4",
        durationMs: 20000,
        sizeBytes: 1,
        container: "mp4",
        streams: {},
        etag: "e1",
      }),
    );
    const registry = AtomRegistry.make();
    const api = {
      mediaRequest: vi.fn(() =>
        Promise.resolve(
          new Response(new Uint8Array([1]), {
            headers: {
              "X-Preview-Start": "0",
              "X-Preview-Duration": "8000",
              "X-Preview-Offset": "0",
            },
          }),
        ),
      ),
      assetRequest: vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    };
    const server = createServerState(api as never, registry, {
      serverBaseUrl: "http://localhost",
      authentication: { type: "none" },
    });
    let position = 0;
    let controller!: ReturnType<typeof createPreviewController>;
    let disposeRoot!: () => void;
    createRoot((dispose) => {
      disposeRoot = dispose;
      createComponent(RegistryContext.Provider, {
        value: registry,
        get children() {
          controller = createPreviewController(api as never, {
            server,
            selectedAtom: selected,
            selected: () => registry.get(selected),
            playheadMs: () => position,
            activeSegment: () => ({ startMs: 1000, endMs: 2000 }),
            segments: () => [
              { startMs: 1000, endMs: 2000 },
              { startMs: 4000, endMs: 5000 },
            ],
            preferences: () => defaultBrowserPreferences,
            savePreferences: () => {},
            updatePlaybackPosition: (ms) => {
              position = ms;
            },
          });
          return undefined;
        },
      });
    });
    const attach = () => controller.setVideo(player as unknown as HTMLVideoElement);
    const load = async () => {
      await vi.waitFor(() => expect(sources.length).toBeGreaterThan(0));
      sources.at(-1)!.dispatchEvent(new Event("sourceopen"));
      await vi.waitFor(() => expect(controller.diagnostics()).toBeDefined());
      expect(api.mediaRequest).toHaveBeenLastCalledWith(
        expect.stringMatching(/preview\?centerMs=\d+&beforeMs=2000&afterMs=6000$/),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    };
    const dispose = () => {
      controller.setVideo(undefined);
      disposeRoot();
      registry.dispose();
    };
    return {
      controller,
      registry,
      selected,
      player,
      sources,
      buffers,
      revoke,
      api,
      attach,
      load,
      dispose,
      position: () => position,
    };
  }

  it("observes native playing, readiness, time and pause without replaying or seeking", async () => {
    const s = setup();
    s.attach();
    await s.load();
    s.controller.togglePlayback();
    expect(s.controller.playbackIntent()).toBe(true);
    expect(s.controller.playing()).toBe(false);
    expect(s.controller.ready()).toBe(false);
    s.player.readyState = 2;
    s.player.dispatchEvent(new Event("loadeddata"));
    s.player.paused = false;
    s.player.dispatchEvent(new Event("playing"));
    expect(s.controller.ready()).toBe(true);
    expect(s.controller.playing()).toBe(true);
    s.player.currentTime = 1.15;
    s.player.dispatchEvent(new Event("seeking"));
    s.player.dispatchEvent(new Event("timeupdate"));
    s.player.dispatchEvent(new Event("seeked"));
    expect(s.position()).toBe(0);
    s.player.currentTime = 1.2;
    s.player.dispatchEvent(new Event("timeupdate"));
    s.player.dispatchEvent(new Event("timeupdate"));
    expect(s.position()).toBe(1200);
    expect(s.player.currentTime).toBe(1.2);
    expect(s.player.play).toHaveBeenCalledOnce();
    s.player.pause();
    expect(s.controller.playbackIntent()).toBe(false);
    expect(s.controller.playing()).toBe(false);
    s.dispose();
  });

  it("reports native source errors without hiding editing or retaining playback intent", async () => {
    const s = setup();
    try {
      s.attach();
      await s.load();
      s.controller.togglePlayback();
      s.player.dispatchEvent(new Event("error"));
      expect(s.controller.previewStatus()).toBe("Preview data could not be played. Try again.");
      expect(s.controller.playbackIntent()).toBe(false);
      expect(s.controller.playing()).toBe(false);
    } finally {
      s.dispose();
    }
  });

  it("reports rejected native play and ignores rejection/events after detach", async () => {
    const s = setup();
    s.attach();
    await s.load();
    s.player.play.mockRejectedValueOnce(new Error("private browser detail"));
    s.controller.togglePlayback();
    await vi.waitFor(() => expect(s.controller.playbackIntent()).toBe(false));
    expect(s.controller.previewStatus()).toContain("Playback could not start");
    expect(s.controller.previewStatus()).not.toContain("private browser detail");
    s.controller.setVideo(undefined);
    const before = s.position();
    s.player.currentTime = 6;
    s.player.dispatchEvent(new Event("timeupdate"));
    s.player.dispatchEvent(new Event("loadeddata"));
    expect(s.position()).toBe(before);
    expect(s.controller.ready()).toBe(false);
    await vi.waitFor(() => expect(s.revoke).toHaveBeenCalled());
    s.dispose();
  });

  it("stops exact bounds, loops and advances included segments in order", async () => {
    const s = setup();
    s.attach();
    await s.load();
    s.controller.playActiveSegment(false);
    await vi.waitFor(() => expect(s.sources).toHaveLength(2));
    await s.load();
    s.player.currentTime = 2.1;
    s.player.dispatchEvent(new Event("timeupdate"));
    expect(s.position()).toBe(2000);
    expect(s.controller.playbackIntent()).toBe(false);
    s.controller.playActiveSegment(true);
    await vi.waitFor(() => expect(s.sources).toHaveLength(3));
    await s.load();
    s.player.currentTime = 2;
    s.player.dispatchEvent(new Event("timeupdate"));
    expect(s.position()).toBe(1000);
    expect(s.controller.playbackIntent()).toBe(true);
    s.controller.playOrderedSegments();
    await vi.waitFor(() => expect(s.sources.length).toBeGreaterThanOrEqual(4));
    await s.load();
    s.player.currentTime = 2;
    s.player.dispatchEvent(new Event("timeupdate"));
    expect(s.position()).toBe(4000);
    expect(s.controller.playbackIntent()).toBe(true);
    s.dispose();
  });

  it("reports autoplay rejection from the stream adapter and preserves scene seeking", async () => {
    const s = setup();
    s.attach();
    await s.load();
    s.controller.playDetectionPoint(5000);
    expect(s.position()).toBe(5000);
    expect(s.controller.playbackMode()).toBe("active-segment");
    await vi.waitFor(() => expect(s.sources).toHaveLength(2));
    await s.load();
    s.player.play.mockRejectedValueOnce(new Error("private autoplay failure"));
    s.buffers.at(-1)!.dispatchEvent(new Event("updateend"));
    await vi.waitFor(() => expect(s.controller.playbackIntent()).toBe(false));
    expect(s.controller.previewStatus()).toContain("Playback could not start");
    expect(s.controller.previewStatus()).not.toContain("private autoplay failure");
    s.controller.seekDetectionPoint(6000);
    expect(s.position()).toBe(6000);
    expect(s.controller.playbackMode()).toBe("whole-media");
    expect(s.controller.playbackIntent()).toBe(false);
    expect(s.controller.previewCenterMs()).toBe(6000);
    s.dispose();
  });

  it("ignores a late play rejection after detach and reports unsupported preview safely", async () => {
    const s = setup();
    s.attach();
    await s.load();
    let reject!: (error: Error) => void;
    s.player.play.mockImplementationOnce(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    s.controller.togglePlayback();
    s.controller.setVideo(undefined);
    reject(new Error("old player failure"));
    await Promise.resolve();
    expect(s.controller.previewStatus()).not.toContain("Playback could not start");
    expect(s.controller.playbackIntent()).toBe(false);
    vi.stubGlobal("MediaSource", undefined);
    s.controller.playSegment({ startMs: 1000, endMs: 2000 });
    expect(s.controller.previewStatus()).toContain("Preview is unavailable in this browser");
    expect(s.controller.playbackIntent()).toBe(false);
    s.dispose();
  });

  it("renews once near the bounded window end and resets media context", async () => {
    const s = setup();
    s.attach();
    await s.load();
    s.controller.togglePlayback();
    s.player.currentTime = 7.1;
    s.player.dispatchEvent(new Event("timeupdate"));
    s.player.dispatchEvent(new Event("timeupdate"));
    expect(s.controller.previewCenterMs()).toBe(7100);
    await vi.waitFor(() => expect(s.sources).toHaveLength(2));
    s.registry.set(s.selected, { ...s.registry.get(s.selected)!, id: "m2" });
    expect(s.controller.playbackIntent()).toBe(false);
    expect(s.controller.diagnostics()).toBeUndefined();
    s.player.currentTime = 5;
    s.player.dispatchEvent(new Event("timeupdate"));
    expect(s.position()).toBe(7100);
    s.dispose();
  });
});
