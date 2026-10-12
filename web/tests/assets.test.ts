import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createServerState } from "../src/app/server";
import { createPreviewAssets } from "../src/features/preview/resources";
import { createThumbnailObjectURL } from "../src/features/media/thumbnail";
import { defaultBrowserPreferences } from "../src/features/settings/model";
import type { Media } from "../src/generated/effect-api";
import { describe, expect, it, vi } from "vitest";
import {
  maxAssetDurationMs,
  normalizePeaks,
  viewportScale,
  visibleAssetRanges,
} from "../src/features/preview/assets";

describe("library thumbnail response lifecycle", () => {
  it("cancels rejected, late, aborted-read and disposed response bodies", async () => {
    const makeResponse = () => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull() {},
          cancel,
        }),
      );
      return { response, cancel };
    };
    const urlAPI = { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() };

    const failed = makeResponse();
    expect(
      await createThumbnailObjectURL(
        new Response(failed.response.body, { status: 503 }),
        new AbortController().signal,
        urlAPI,
      ),
    ).toBeUndefined();
    expect(failed.cancel).toHaveBeenCalledOnce();

    const late = makeResponse();
    const lateSignal = new AbortController();
    lateSignal.abort();
    expect(
      await createThumbnailObjectURL(late.response, lateSignal.signal, urlAPI),
    ).toBeUndefined();
    expect(late.cancel).toHaveBeenCalledOnce();

    const disposed = makeResponse();
    const disposedSignal = new AbortController();
    const reading = createThumbnailObjectURL(disposed.response, disposedSignal.signal, urlAPI);
    await vi.waitFor(() => expect(disposed.response.body?.locked).toBe(true));
    disposedSignal.abort();
    expect(await reading).toBeUndefined();
    expect(disposed.cancel).toHaveBeenCalledOnce();
    expect(urlAPI.createObjectURL).not.toHaveBeenCalled();
    expect(urlAPI.revokeObjectURL).not.toHaveBeenCalled();
  });
});

describe("timeline assets", () => {
  it("normalizes bounded waveform peaks", () => {
    expect(normalizePeaks([-1, 0.5, 2, "bad", Infinity, Number.NaN])).toEqual([0, 0.5, 1]);
  });
  it("keeps viewport zoom bounded", () => {
    expect(viewportScale(0)).toBe(1);
    expect(viewportScale(4)).toBe(4);
    expect(viewportScale(40)).toBe(16);
  });
  it("requests the visible interval instead of the media prefix", () => {
    expect(visibleAssetRanges({ startMs: 180_000, endMs: 240_000 }, 600_000)).toEqual([
      { startMs: 180_000, durationMs: 60_000 },
    ]);
  });
  it("clamps a viewport at the media end while preserving the visible interval", () => {
    expect(visibleAssetRanges({ startMs: 599_900, endMs: 700_000 }, 600_000)).toEqual([
      { startMs: 599_900, durationMs: 100 },
    ]);
    expect(visibleAssetRanges({ startMs: 0, endMs: 600_000, widthPx: 1600 }, 600_000)).toEqual([
      { startMs: 0, durationMs: maxAssetDurationMs },
      { startMs: maxAssetDurationMs, durationMs: maxAssetDurationMs },
      { startMs: maxAssetDurationMs * 2, durationMs: maxAssetDurationMs },
      { startMs: maxAssetDurationMs * 3, durationMs: maxAssetDurationMs },
      { startMs: maxAssetDurationMs * 4, durationMs: maxAssetDurationMs },
    ]);
  });
  it("tiles long visible intervals into bounded asset requests", () => {
    expect(visibleAssetRanges({ startMs: 0, endMs: 300_000 }, 600_000)).toEqual([
      { startMs: 0, durationMs: maxAssetDurationMs },
      { startMs: maxAssetDurationMs, durationMs: maxAssetDurationMs },
      { startMs: maxAssetDurationMs * 2, durationMs: 60_000 },
    ]);
  });
  it("bounds ten-hour overview work while sampling its beginning middle and end", () => {
    const duration = 36_000_000;
    const ranges = visibleAssetRanges({ startMs: 0, endMs: duration, widthPx: 960 }, duration);
    expect(ranges).toEqual([
      { startMs: 0, durationMs: maxAssetDurationMs },
      { startMs: (duration - maxAssetDurationMs) / 2, durationMs: maxAssetDurationMs },
      { startMs: duration - maxAssetDurationMs, durationMs: maxAssetDurationMs },
    ]);
    expect(
      visibleAssetRanges({ startMs: 0, endMs: duration, widthPx: 100000 }, duration),
    ).toHaveLength(8);
  });
});

// Native requests deliberately ignore abort: registry interruption must still reject late publication.
describe("workspace preview resources", () => {
  it.each(["thumbnails", "waveform"])(
    "cancels %s bodies after headers, including late and failed responses",
    async (kind) => {
      const registry = AtomRegistry.make();
      const requests: Array<{
        kind: string;
        signal: AbortSignal;
        resolve: (response: Response) => void;
      }> = [];
      const api = {
        assetRequest: (
          _id: string,
          kind: string,
          _params: Record<string, number>,
          { signal }: { signal: AbortSignal },
        ) => new Promise<Response>((resolve) => requests.push({ kind, signal, resolve })),
      };
      const server = createServerState(api as never, registry, {
        serverBaseUrl: "http://localhost",
        authentication: { type: "none" },
      });
      registry.set(server.preferences.value, {
        ...defaultBrowserPreferences,
        waveformVisible: kind === "waveform",
      });
      const selected = Atom.keepAlive(
        Atom.make<Media | undefined>({
          id: "media",
          name: "media",
          durationMs: 1000,
          sizeBytes: 1,
          container: "mp4",
          streams: {},
          etag: "media",
        }),
      );
      const assets = createPreviewAssets(server, api as never, selected);
      registry.mount(assets.view);
      const pending = () => requests.filter((request) => request.kind === kind);
      const blockedBody = (signal: AbortSignal) => {
        const cancel = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            }),
        );
        const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
        return { response, cancel };
      };
      try {
        await vi.waitFor(() => expect(pending()).toHaveLength(1));
        const first = blockedBody(pending()[0].signal);
        pending()[0].resolve(first.response);
        await vi.waitFor(() => expect(first.response.body?.locked).toBe(true));
        assets.retry();
        await vi.waitFor(() => expect(pending()).toHaveLength(2));
        await vi.waitFor(() => expect(first.cancel).toHaveBeenCalledOnce());
        expect(first.response.body?.locked).toBe(false);
        await vi.waitFor(() => expect(pending()[0].signal.aborted).toBe(true));

        assets.retry();
        await vi.waitFor(() => expect(pending()).toHaveLength(3));
        const late = blockedBody(pending()[1].signal);
        pending()[1].resolve(late.response);
        await vi.waitFor(() => expect(late.cancel).toHaveBeenCalledOnce());

        const failed = blockedBody(pending()[2].signal);
        pending()[2].resolve(new Response(failed.response.body, { status: 503 }));
        await vi.waitFor(() => expect(failed.cancel).toHaveBeenCalledOnce());

        assets.retry();
        await vi.waitFor(() => expect(pending()).toHaveLength(4));
        const last = blockedBody(pending()[3].signal);
        pending()[3].resolve(last.response);
        await vi.waitFor(() => expect(last.response.body?.locked).toBe(true));
        registry.dispose();
        await vi.waitFor(() => expect(last.cancel).toHaveBeenCalledOnce());
        expect(last.response.body?.locked).toBe(false);
        await vi.waitFor(() => expect(pending()[3].signal.aborted).toBe(true));
      } finally {
        registry.dispose();
      }
    },
  );
  it("bounds requests, clears obsolete assets, releases URLs/listeners and retains partial failures", async () => {
    const registry = AtomRegistry.make();
    const requests: Array<{
      id: string;
      kind: string;
      params: Record<string, number>;
      signal: AbortSignal;
      resolve: (response: Response) => void;
    }> = [];
    const api = {
      assetRequest: (
        id: string,
        kind: string,
        params: Record<string, number>,
        options: { signal: AbortSignal },
      ) =>
        new Promise<Response>((resolve) =>
          requests.push({ id, kind, params, signal: options.signal, resolve }),
        ),
      mediaRequest: vi.fn(),
    };
    const server = createServerState(api as never, registry, {
      serverBaseUrl: "http://localhost",
      authentication: { type: "none" },
    });
    registry.set(server.preferences.value, {
      ...defaultBrowserPreferences,
      waveformVisible: false,
    });
    const media = (id: string) => ({
      id,
      name: id,
      durationMs: 600_000,
      sizeBytes: 1,
      container: "mp4",
      streams: {},
      etag: id,
    });
    const selected = Atom.keepAlive(Atom.make<Media | undefined>(media("old")));
    const images: Array<{
      onload: (() => void) | null;
      onerror: (() => void) | null;
      src: string;
      naturalHeight: number;
    }> = [];
    vi.stubGlobal(
      "Image",
      class {
        onload = null;
        onerror = null;
        src = "";
        naturalHeight = 180;
        constructor() {
          images.push(this);
        }
      },
    );
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let next = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:${++next}`);
    vi.stubGlobal("document", {
      createElement: () => ({
        getContext: () => ({ drawImage: vi.fn() }),
        toBlob: (done: (blob: Blob) => void) => done(new Blob(["strip"])),
      }),
    });
    const assets = createPreviewAssets(server, api as never, selected);
    const unmount = registry.mount(assets.view);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(
      requests.every(
        (r) =>
          r.kind === "thumbnails" &&
          r.params.durationMs <= 120_000 &&
          r.params.count === 16 &&
          r.params.width === 320,
      ),
    ).toBe(true);
    registry.set(selected, media("new"));
    await vi.waitFor(() => expect(requests).toHaveLength(6));
    requests.slice(0, 3).forEach((r) => r.resolve(new Response(new Blob(["old"]))));
    requests[3].resolve(new Response(new Blob(["new"])));
    requests[4].resolve(new Response(null, { status: 404 }));
    requests[5].resolve(new Response(null, { status: 404 }));
    await vi.waitFor(() => expect(images).toHaveLength(1));
    images[0].onload?.();
    await vi.waitFor(() => expect(registry.get(assets.view).thumbnailURL).toBe("blob:2"));
    expect(registry.get(assets.view).assetStatus).toBe(
      "Thumbnails unavailable; editing remains available.",
    );
    expect(images[0].onload).toBeNull();
    expect(images[0].onerror).toBeNull();
    assets.setViewport({ startMs: 180_000, endMs: 240_000 });
    await vi.waitFor(() => expect(requests).toHaveLength(7));
    expect(registry.get(assets.view).thumbnailURL).toBeUndefined();
    await vi.waitFor(() =>
      expect(revoke.mock.calls.flat()).toEqual(expect.arrayContaining(["blob:1", "blob:2"])),
    );
    requests[6].resolve(new Response(new Blob(["pending-image"])));
    await vi.waitFor(() => expect(images).toHaveLength(2));
    assets.retry();
    await vi.waitFor(() => expect(requests).toHaveLength(8));
    expect(images[1].onload).toBeNull();
    expect(images[1].onerror).toBeNull();
    expect(images[1].src).toBe("");
    registry.set(server.preferences.value, { ...defaultBrowserPreferences, waveformVisible: true });
    await vi.waitFor(() => expect(requests.filter((r) => r.kind === "waveform")).toHaveLength(1));
    const wave = requests.find((r) => r.kind === "waveform")!;
    expect(wave.params).toEqual({ startMs: 180_000, durationMs: 60_000, samples: 256 });
    wave.resolve(
      Response.json({ startMs: 180_000, durationMs: 60_000, peaks: new Array(16).fill(0.5) }),
    );
    await vi.waitFor(() => expect(registry.get(assets.view).waveform[0]).toBe(0.5));
    unmount();
    const remount = registry.mount(assets.view);
    expect(registry.get(assets.view).waveform[0]).toBe(0.5);
    expect(requests).toHaveLength(9);
    remount();
    registry.dispose();
    await vi.waitFor(() => expect(requests[7].signal.aborted).toBe(true));
    expect(revoke).toHaveBeenCalledWith("blob:3");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});
