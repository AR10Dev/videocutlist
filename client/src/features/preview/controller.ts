import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { ApiClient } from "../../api";
import type { components } from "../../generated/api";
import { normalizePeaks } from "./assets";
import {
  canStreamPreview,
  clampMediaPosition,
  streamPreview,
  watchedMediaPosition,
  type PreviewDiagnostics,
  type PreviewPlaybackMode,
} from "./model";

type Media = components["schemas"]["Media"];

export function createPreviewController(
  api: ApiClient,
  dependencies: {
    selected: Accessor<Media | undefined>;
    playheadMs: Accessor<number>;
    updatePlaybackPosition: (positionMs: number) => void;
  },
) {
  const [assetStatus, setAssetStatus] = createSignal("");
  const [previewStatus, setPreviewStatus] = createSignal("");
  const [thumbnailURL, setThumbnailURL] = createSignal<string>();
  const [waveform, setWaveform] = createSignal<number[]>([]);
  const [previewCenterMs, setPreviewCenterMs] = createSignal(0);
  const [previewReload, setPreviewReload] = createSignal(0);
  const [diagnostics, setDiagnostics] = createSignal<PreviewDiagnostics>();
  // Settings unmounts the player; a new element must trigger preview attachment.
  const [video, setVideo] = createSignal<HTMLVideoElement>();
  let assetRequest: AbortController | undefined;
  let previewRequest: AbortController | undefined;
  let cleanupPreview: (() => void) | undefined;
  let thumbnailObjectURL: string | undefined;
  let previewGeneration = 0;
  let renewalGeneration = -1;
  let selectedMediaId: string | undefined;
  const previewRenewalLeadMs = 1000;
  const [playbackIntent, setPlaybackIntent] = createSignal(false);
  const playbackMode = (): PreviewPlaybackMode => "whole-media";

  createEffect(() => {
    const item = dependencies.selected();
    if (item?.id !== selectedMediaId) {
      selectedMediaId = item?.id;
      setPlaybackIntent(false);
      video()?.pause();
    }
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
    assetRequest?.abort();
    previewRequest?.abort();
    cleanupPreview?.();
    if (thumbnailObjectURL) URL.revokeObjectURL(thumbnailObjectURL);
  });

  const watchedPosition = () => dependencies.playheadMs();
  const requestRenewal = (positionMs: number, force = false) => {
    const item = dependencies.selected();
    const info = diagnostics();
    if (!item || !info || !playbackIntent() || info.durationMs <= 0) return false;
    const position = clampMediaPosition(positionMs, item.durationMs);
    if (position >= item.durationMs) return false;
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
    dependencies.updatePlaybackPosition(position);
    if (!playbackIntent()) return;
    if (position >= item.durationMs || !requestRenewal(position, true)) setPlaybackIntent(false);
  };
  const togglePlayback = () => {
    const player = video();
    const nextIntent = !playbackIntent();
    setPlaybackIntent(nextIntent);
    if (!nextIntent) {
      player?.pause();
      return;
    }
    if (!diagnostics() && previewStatus().includes("Try again."))
      setPreviewReload((value) => value + 1);
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

  return {
    assetStatus,
    previewStatus,
    thumbnailURL,
    waveform,
    previewCenterMs,
    setPreviewCenterMs,
    diagnostics,
    setDiagnostics,
    playbackMode,
    playbackIntent,
    watchedPosition,
    syncPreviewPosition,
    handlePreviewEnded,
    setVideo,
    togglePlayback,
    pausePlayback,
  };
}
