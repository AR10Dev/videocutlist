import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { ApiClient } from "../../api";
import type { components } from "../../generated/api";
import { normalizePeaks, visibleAssetRanges, type AssetRange, type AssetViewport } from "./assets";
import {
  canStreamPreview,
  clampMediaPosition,
  previewRange,
  streamPreview,
  watchedMediaPosition,
  segmentIncluded,
  type PreviewDiagnostics,
  type PreviewPlaybackMode,
  type Segment,
} from "./model";

type Media = components["schemas"]["Media"];

const waveformPreferenceKey = "videocutlist.waveform-visible.v1";
const loopPreferenceKey = "videocutlist.loop-selected-segment.v1";
const initialWaveformVisibility = () => {
  try {
    return globalThis.localStorage?.getItem(waveformPreferenceKey) !== "false";
  } catch {
    return true;
  }
};
const initialLoopPreference = () => {
  try {
    return globalThis.localStorage?.getItem(loopPreferenceKey) === "true";
  } catch {
    return false;
  }
};

type AssetRequestResult = {
  range: AssetRange;
  thumbnailURL?: string;
  waveform: number[];
  thumbnailFailed: boolean;
  waveformFailed: boolean;
};

function loadThumbnail(url: string, signal: AbortSignal): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (value?: HTMLImageElement) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => finish();
    image.onload = () => finish(image);
    image.onerror = () => finish();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return finish();
    image.src = url;
  });
}

async function composeThumbnailStrip(
  urls: (string | undefined)[],
  signal: AbortSignal,
): Promise<string | undefined> {
  const images = await Promise.all(
    urls.map((url) => (url ? loadThumbnail(url, signal) : Promise.resolve(undefined))),
  );
  if (signal.aborted || !images.some(Boolean)) return undefined;
  const tileWidth = 320;
  const tileHeight = Math.max(1, ...images.map((image) => image?.naturalHeight || 180));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, tileWidth * urls.length);
  canvas.height = tileHeight;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  images.forEach((image, index) => {
    if (image) context.drawImage(image, index * tileWidth, 0, tileWidth, tileHeight);
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob || signal.aborted) return undefined;
  return URL.createObjectURL(blob);
}

export function createPreviewController(
  api: ApiClient,
  dependencies: {
    selected: Accessor<Media | undefined>;
    playheadMs: Accessor<number>;
    activeSegment: Accessor<Segment | undefined>;
    segments: Accessor<Segment[]>;
    visibleRange: Accessor<AssetViewport>;
    updatePlaybackPosition: (positionMs: number) => void;
  },
) {
  const [assetStatus, setAssetStatus] = createSignal("");
  const [previewStatus, setPreviewStatus] = createSignal("");
  const [waveformVisible, setWaveformVisible] = createSignal(initialWaveformVisibility());
  const [assetReload, setAssetReload] = createSignal(0);
  const [thumbnailURL, setThumbnailURL] = createSignal<string>();
  const [waveform, setWaveform] = createSignal<number[]>([]);
  const [assetRange, setAssetRange] = createSignal<AssetRange>();
  const [previewCenterMs, setPreviewCenterMs] = createSignal(0);
  const [previewReload, setPreviewReload] = createSignal(0);
  const [diagnostics, setDiagnostics] = createSignal<PreviewDiagnostics>();
  // Settings unmounts the player; a new element must trigger preview attachment.
  const [video, setVideo] = createSignal<HTMLVideoElement>();
  let assetRequest: AbortController | undefined;
  let previewRequest: AbortController | undefined;
  let cleanupPreview: (() => void) | undefined;
  let thumbnailObjectURL: string | undefined;
  let thumbnailTileURLs: string[] = [];
  let assetGeneration = 0;
  let previewGeneration = 0;
  let renewalGeneration = -1;
  let selectedMediaId: string | undefined;
  const previewRenewalLeadMs = 1000;
  const [playbackIntent, setPlaybackIntent] = createSignal(false);
  const [playbackMode, setPlaybackMode] = createSignal<PreviewPlaybackMode>("whole-media");
  const [loopSelectedSegment, setLoopSelectedSegmentState] = createSignal(initialLoopPreference());
  const [orderedSegmentIndex, setOrderedSegmentIndex] = createSignal(0);
  // Candidate review uses the same bounded playback mode without changing the durable timeline.
  const [boundedSegment, setBoundedSegment] = createSignal<Segment>();

  createEffect(() => {
    const item = dependencies.selected();
    if (item?.id !== selectedMediaId) {
      selectedMediaId = item?.id;
      setPlaybackIntent(false);
      setPlaybackMode("whole-media");
      setOrderedSegmentIndex(0);
      setBoundedSegment();
      video()?.pause();
    }
    setPreviewStatus("");
  });
  createEffect(() => {
    const item = dependencies.selected();
    const viewport = dependencies.visibleRange();
    assetReload();
    assetRequest?.abort();
    thumbnailTileURLs.forEach((url) => URL.revokeObjectURL(url));
    thumbnailTileURLs = [];
    if (thumbnailObjectURL) URL.revokeObjectURL(thumbnailObjectURL);
    thumbnailObjectURL = undefined;
    setThumbnailURL();
    setWaveform([]);
    setAssetRange();
    setAssetStatus("");
    const generation = ++assetGeneration;
    if (!item) return;
    const ranges = visibleAssetRanges(viewport, item.durationMs);
    const controller = new AbortController();
    assetRequest = controller;
    const current = () => !controller.signal.aborted && generation === assetGeneration;
    const requests = ranges.map(async (range): Promise<AssetRequestResult> => {
      let thumbnailURL: string | undefined;
      let thumbnailFailed = false;
      try {
        const response = await api.assetRequest(
          item.id,
          "thumbnails",
          { startMs: range.startMs, durationMs: range.durationMs, count: 16, width: 320 },
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error();
        thumbnailURL = URL.createObjectURL(await response.blob());
      } catch {
        thumbnailFailed = true;
      }
      let waveform: number[] = [];
      let waveformFailed = false;
      try {
        const response = await api.assetRequest(
          item.id,
          "waveform",
          { startMs: range.startMs, durationMs: range.durationMs, samples: 256 },
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error();
        const value = (await response.json()) as { peaks?: unknown };
        waveform = normalizePeaks(value.peaks);
      } catch {
        waveformFailed = true;
      }
      return { range, thumbnailURL, waveform, thumbnailFailed, waveformFailed };
    });
    void Promise.all(requests).then(async (results) => {
      if (!current()) {
        results.forEach(
          (result) => result.thumbnailURL && URL.revokeObjectURL(result.thumbnailURL),
        );
        return;
      }
      const thumbnailURLs = results.map((result) => result.thumbnailURL);
      const combinedThumbnail =
        ranges.length === 1 && thumbnailURLs.filter(Boolean).length === 1
          ? thumbnailURLs.find(Boolean)
          : await composeThumbnailStrip(thumbnailURLs, controller.signal);
      const fullRange = {
        startMs: ranges[0].startMs,
        durationMs:
          ranges[ranges.length - 1].startMs +
          ranges[ranges.length - 1].durationMs -
          ranges[0].startMs,
      };
      if (!current()) {
        thumbnailURLs.forEach((url) => url && URL.revokeObjectURL(url));
        if (combinedThumbnail && combinedThumbnail !== thumbnailURLs.find(Boolean))
          URL.revokeObjectURL(combinedThumbnail);
        return;
      }
      thumbnailTileURLs = thumbnailURLs.filter((url): url is string => Boolean(url));
      thumbnailObjectURL =
        combinedThumbnail && combinedThumbnail !== thumbnailURLs.find(Boolean)
          ? combinedThumbnail
          : undefined;
      setThumbnailURL(combinedThumbnail);
      setWaveform(results.flatMap((result) => result.waveform));
      setAssetRange(fullRange);
      const unavailable: string[] = [];
      if (results.some((result) => result.thumbnailFailed))
        unavailable.push("Thumbnails unavailable");
      if (results.some((result) => result.waveformFailed)) unavailable.push("Waveform unavailable");
      setAssetStatus(
        unavailable.length ? `${unavailable.join("; ")}; editing remains available.` : "",
      );
    });
    onCleanup(() => controller.abort());
  });
  createEffect(() => {
    const item = dependencies.selected();
    const position = previewCenterMs();
    previewReload();
    const generation = ++previewGeneration;
    cleanupPreview?.();
    cleanupPreview = undefined;
    previewRequest?.abort();
    setDiagnostics();
    renewalGeneration = -1;
    const player = video();
    if (!item || !player || !canStreamPreview()) return;
    const timer = window.setTimeout(() => {
      const request = new AbortController();
      previewRequest = request;
      const current = () => !request.signal.aborted && generation === previewGeneration;
      const params = new URLSearchParams({
        centerMs: String(Math.round(position)),
        beforeMs: "2000",
        afterMs: "6000",
      });
      setPreviewStatus("Loading preview…");
      cleanupPreview = streamPreview(
        player,
        () =>
          api.request(`media/${encodeURIComponent(item.id)}/preview?${params}`, {
            signal: request.signal,
          }),
        (value) => {
          if (current()) {
            setDiagnostics(value);
            setPreviewStatus("");
          }
        },
        (error) => {
          if (current()) {
            setPlaybackIntent(false);
            setPreviewStatus(error.message);
          }
        },
        () => current() && playbackIntent(),
      );
    }, 200);
    onCleanup(() => {
      window.clearTimeout(timer);
      previewRequest?.abort();
      cleanupPreview?.();
      cleanupPreview = undefined;
    });
  });
  onCleanup(() => {
    setPlaybackIntent(false);
    assetGeneration += 1;
    assetRequest?.abort();
    previewRequest?.abort();
    cleanupPreview?.();
    thumbnailTileURLs.forEach((url) => URL.revokeObjectURL(url));
    thumbnailTileURLs = [];
    if (thumbnailObjectURL) URL.revokeObjectURL(thumbnailObjectURL);
  });

  const watchedPosition = () => dependencies.playheadMs();
  const orderedSegments = () => dependencies.segments().filter(segmentIncluded).slice();
  const playbackBounds = (item: Media) =>
    previewRange(
      playbackMode(),
      item.durationMs,
      boundedSegment() ?? dependencies.activeSegment(),
      orderedSegments(),
      orderedSegmentIndex(),
    );
  const restartPreview = (positionMs: number) => {
    setPreviewCenterMs(positionMs);
    setPreviewReload((value: number) => value + 1);
  };
  const stopAtBoundary = (positionMs: number) => {
    const item = dependencies.selected();
    const info = diagnostics();
    const player = video();
    const position = item ? clampMediaPosition(positionMs, item.durationMs) : positionMs;
    if (player && info) {
      player.pause();
      player.currentTime = Math.max(0, position - info.startMs) / 1000;
    }
    dependencies.updatePlaybackPosition(position);
    setPlaybackIntent(false);
  };
  const advancePlayback = (positionMs: number) => {
    const item = dependencies.selected();
    if (!item || !playbackIntent()) return;
    const bounds = playbackBounds(item);
    if (positionMs < bounds.endMs) return;
    const mode = playbackMode();
    if (mode === "active-segment-loop") {
      dependencies.updatePlaybackPosition(bounds.startMs);
      restartPreview(bounds.startMs);
      return;
    }
    if (mode === "ordered-segments") {
      const segments = orderedSegments();
      const nextIndex = orderedSegmentIndex() + 1;
      if (nextIndex < segments.length) {
        setOrderedSegmentIndex(nextIndex);
        dependencies.updatePlaybackPosition(segments[nextIndex].startMs);
        restartPreview(segments[nextIndex].startMs);
        return;
      }
    }
    stopAtBoundary(bounds.endMs);
  };
  const requestRenewal = (positionMs: number, force = false) => {
    const item = dependencies.selected();
    const info = diagnostics();
    if (!item || !info || !playbackIntent() || info.durationMs <= 0) return false;
    const position = clampMediaPosition(positionMs, item.durationMs);
    const bounds = playbackBounds(item);
    if (position >= bounds.endMs) {
      advancePlayback(position);
      return false;
    }
    const windowEnd = Math.min(item.durationMs, info.startMs + info.durationMs);
    if (!force && windowEnd - position > previewRenewalLeadMs) return false;
    if (renewalGeneration === previewGeneration) return true;
    renewalGeneration = previewGeneration;
    setPreviewCenterMs(position);
    return true;
  };
  const syncPreviewPosition = (currentTime: number) => {
    const item = dependencies.selected();
    const info = diagnostics();
    if (!item || !info) return;
    const position = watchedMediaPosition(info.startMs, currentTime, item.durationMs);
    if (playbackIntent()) {
      const bounds = playbackBounds(item);
      if (position >= bounds.endMs) {
        advancePlayback(position);
        return;
      }
    }
    dependencies.updatePlaybackPosition(position);
    if (playbackIntent()) requestRenewal(position);
  };
  const handlePreviewEnded = (currentTime: number) => {
    const item = dependencies.selected();
    const info = diagnostics();
    if (!item) {
      setPlaybackIntent(false);
      return;
    }
    if (!info) return;
    const position = watchedMediaPosition(info.startMs, currentTime, item.durationMs);
    if (playbackIntent()) {
      const bounds = playbackBounds(item);
      if (position >= bounds.endMs) {
        advancePlayback(position);
        return;
      }
    }
    dependencies.updatePlaybackPosition(position);
    if (!playbackIntent() || !requestRenewal(position, true)) setPlaybackIntent(false);
  };
  const startPlayback = (mode: PreviewPlaybackMode, positionMs: number, segment?: Segment) => {
    setPlaybackMode(mode);
    setBoundedSegment(
      mode === "active-segment" || mode === "active-segment-loop" ? segment : undefined,
    );
    setPlaybackIntent(true);
    dependencies.updatePlaybackPosition(positionMs);
    restartPreview(positionMs);
  };
  const playSegment = (segment: Segment, loop = false) => {
    const item = dependencies.selected();
    if (!canStreamPreview()) {
      setPreviewStatus(
        "Preview is unavailable in this browser. Use the I and O keyboard shortcuts instead.",
      );
      return;
    }
    if (
      !item ||
      !Number.isInteger(segment.startMs) ||
      !Number.isInteger(segment.endMs) ||
      segment.startMs < 0 ||
      segment.startMs >= segment.endMs ||
      segment.endMs > item.durationMs
    ) {
      setPreviewStatus("That candidate has invalid playback bounds.");
      return;
    }
    startPlayback(loop ? "active-segment-loop" : "active-segment", segment.startMs, segment);
  };
  const setLoopSelectedSegment = (enabled: boolean) => {
    setLoopSelectedSegmentState(enabled);
    try {
      globalThis.localStorage?.setItem(loopPreferenceKey, String(enabled));
    } catch {
      // Browser storage may be disabled; the preference remains available for this session.
    }
  };
  const playActiveSegment = (loop: boolean) => {
    const segment = dependencies.activeSegment();
    if (!segment) {
      setPreviewStatus("Select a cut to play it.");
      return;
    }
    if (loop) setLoopSelectedSegment(true);
    playSegment(segment, loop);
  };
  const toggleLoopSelectedSegment = () => {
    const next = !loopSelectedSegment();
    setLoopSelectedSegment(next);
    const segment = dependencies.activeSegment();
    if (segment) playSegment(segment, next);
  };
  const playOrderedSegments = () => {
    const segments = orderedSegments();
    if (!segments.length) {
      setPreviewStatus("Add a cut before previewing the selected cuts.");
      return;
    }
    setOrderedSegmentIndex(0);
    startPlayback("ordered-segments", segments[0].startMs);
  };
  const togglePlayback = () => {
    const player = video();
    const nextIntent = !playbackIntent();
    if (!nextIntent) {
      setPlaybackIntent(false);
      player?.pause();
      return;
    }
    const item = dependencies.selected();
    if (item && playbackMode() !== "whole-media") {
      const bounds = playbackBounds(item);
      const position = watchedPosition();
      if (position < bounds.startMs || position >= bounds.endMs) {
        if (playbackMode() === "active-segment" || playbackMode() === "active-segment-loop") {
          const segment = boundedSegment() ?? dependencies.activeSegment();
          if (segment) playSegment(segment, playbackMode() === "active-segment-loop");
        } else {
          const segment = orderedSegments()[orderedSegmentIndex()];
          if (segment) startPlayback("ordered-segments", segment.startMs);
        }
        return;
      }
    }
    setPlaybackIntent(true);
    if (!diagnostics() && previewStatus().includes("Try again."))
      setPreviewReload((value: number) => value + 1);
    void player?.play().catch(() => {
      if (playbackIntent() && diagnostics()) {
        setPlaybackIntent(false);
        setPreviewStatus("Playback could not start. Wait for the preview to load and try again.");
      }
    });
  };
  const pausePlayback = () => {
    setPlaybackIntent(false);
    video()?.pause();
  };
  const setWaveformVisibility = (visible: boolean) => {
    setWaveformVisible(visible);
    try {
      globalThis.localStorage?.setItem(waveformPreferenceKey, String(visible));
    } catch {
      // Browser storage may be disabled; waveform remains available for this session.
    }
  };
  const retryAssets = () => setAssetReload((value: number) => value + 1);

  return {
    assetStatus,
    waveformVisible,
    setWaveformVisibility,
    retryAssets,
    previewStatus,
    thumbnailURL,
    waveform,
    assetRange,
    previewCenterMs,
    setPreviewCenterMs,
    diagnostics,
    setDiagnostics,
    playbackMode,
    playbackIntent,
    loopSelectedSegment,
    setLoopSelectedSegment,
    toggleLoopSelectedSegment,
    watchedPosition,
    syncPreviewPosition,
    handlePreviewEnded,
    setVideo,
    togglePlayback,
    pausePlayback,
    playActiveSegment,
    playOrderedSegments,
    playSegment,
  };
}
