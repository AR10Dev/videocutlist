import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { ApiClient } from "../../api";
import type { components } from "../../generated/api";
import { normalizePeaks } from "./assets";
import {
  canStreamPreview,
  streamPreview,
  watchedMediaPosition,
  type PreviewDiagnostics,
} from "./model";

type Media = components["schemas"]["Media"];

export function createPreviewController(
  api: ApiClient,
  dependencies: {
    selected: Accessor<Media | undefined>;
    muted: Accessor<boolean>;
    playheadMs: Accessor<number>;
    updatePlaybackPosition: (positionMs: number) => void;
  },
) {
  const [assetStatus, setAssetStatus] = createSignal("");
  const [previewStatus, setPreviewStatus] = createSignal("");
  const [thumbnailURL, setThumbnailURL] = createSignal<string>();
  const [waveform, setWaveform] = createSignal<number[]>([]);
  const [previewCenterMs, setPreviewCenterMs] = createSignal(0);
  const [diagnostics, setDiagnostics] = createSignal<PreviewDiagnostics>();
  let video: HTMLVideoElement | undefined;
  let assetRequest: AbortController | undefined;
  let previewRequest: AbortController | undefined;
  let cleanupPreview: (() => void) | undefined;
  let thumbnailObjectURL: string | undefined;
  let shouldPlay = true;

  createEffect(() => {
    const item = dependencies.selected();
    assetRequest?.abort();
    if (thumbnailObjectURL) URL.revokeObjectURL(thumbnailObjectURL);
    thumbnailObjectURL = undefined;
    setThumbnailURL();
    setWaveform([]);
    setAssetStatus("");
    setPreviewStatus("");
    if (!item) return;
    const controller = new AbortController();
    assetRequest = controller;
    const durationMs = Math.max(1, Math.min(120000, item.durationMs));
    void api
      .assetRequest(
        item.id,
        "thumbnails",
        { startMs: 0, durationMs, count: 16, width: 320 },
        { signal: controller.signal },
      )
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.blob();
      })
      .then((blob) => {
        if (!controller.signal.aborted) {
          thumbnailObjectURL = URL.createObjectURL(blob);
          setThumbnailURL(thumbnailObjectURL);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setAssetStatus("Thumbnails unavailable; editing remains available.");
      });
    void api
      .assetRequest(
        item.id,
        "waveform",
        { startMs: 0, durationMs, samples: 256 },
        { signal: controller.signal },
      )
      .then(async (response) => {
        const value = (await response.json()) as { peaks?: unknown };
        if (!response.ok) throw new Error();
        return normalizePeaks(value.peaks);
      })
      .then((peaks) => {
        if (!controller.signal.aborted) setWaveform(peaks);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setAssetStatus("Waveform unavailable; editing remains available.");
      });
    onCleanup(() => controller.abort());
  });
  createEffect(() => {
    const item = dependencies.selected();
    const position = previewCenterMs();
    const isMuted = dependencies.muted();
    cleanupPreview?.();
    cleanupPreview = undefined;
    previewRequest?.abort();
    setDiagnostics();
    const player = video;
    if (!item || !player || !canStreamPreview()) return;
    const timer = window.setTimeout(() => {
      const request = new AbortController();
      previewRequest = request;
      const params = new URLSearchParams({
        centerMs: String(Math.round(position)),
        beforeMs: "2000",
        afterMs: "6000",
        mute: String(isMuted),
      });
      setPreviewStatus("Loading preview…");
      cleanupPreview = streamPreview(
        player,
        () =>
          api.request(`media/${encodeURIComponent(item.id)}/preview?${params}`, {
            signal: request.signal,
          }),
        (value) => {
          if (!request.signal.aborted) {
            setDiagnostics(value);
            setPreviewStatus("");
          }
        },
        (error) => {
          if (!request.signal.aborted) setPreviewStatus(error.message);
        },
        () => shouldPlay,
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
    assetRequest?.abort();
    previewRequest?.abort();
    cleanupPreview?.();
    if (thumbnailObjectURL) URL.revokeObjectURL(thumbnailObjectURL);
  });

  const watchedPosition = () => dependencies.playheadMs();
  const syncPreviewPosition = (currentTime: number) => {
    const item = dependencies.selected();
    const info = diagnostics();
    if (item && info)
      dependencies.updatePlaybackPosition(
        watchedMediaPosition(info.startMs, currentTime, item.durationMs),
      );
  };
  const setVideo = (element: HTMLVideoElement) => {
    video = element;
  };
  const togglePlayback = () => {
    shouldPlay = Boolean(video?.paused);
    if (shouldPlay) void video?.play();
    else video?.pause();
  };
  const pausePlayback = () => {
    shouldPlay = false;
    video?.pause();
  };

  return {
    assetStatus,
    previewStatus,
    thumbnailURL,
    waveform,
    previewCenterMs,
    setPreviewCenterMs,
    diagnostics,
    setDiagnostics,
    watchedPosition,
    syncPreviewPosition,
    setVideo,
    togglePlayback,
    pausePlayback,
  };
}
