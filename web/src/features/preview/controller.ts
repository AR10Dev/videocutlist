import type * as EffectApiTypes from "../../generated/effect-api";
import { type Accessor } from "solid-js";
import { Effect } from "effect";
import { useAtomValue } from "@effect/atom-solid";
import * as Atom from "effect/reactivity/Atom";
import type { ServerState } from "../../app/server";
import { createPreviewAssets } from "./resources";
import { type NativeMediaApiClient } from "../../api";

import type { BrowserPreferences } from "../settings/model";
import {
  canStreamPreview,
  clampMediaPosition,
  previewRange,
  streamPreview,
  previewMediaRequest,
  observePreviewPlayer,
  watchedMediaPosition,
  segmentIncluded,
  type PreviewDiagnostics,
  type PreviewPlaybackMode,
  type Segment,
} from "./model";

type Media = EffectApiTypes.Media;

export function createPreviewController(
  api: NativeMediaApiClient,
  dependencies: {
    server: ServerState;
    selectedAtom: Atom.Atom<Media | undefined>;
    selected: Accessor<Media | undefined>;
    playheadMs: Accessor<number>;
    activeSegment: Accessor<Segment | undefined>;
    segments: Accessor<Segment[]>;
    preferences: Accessor<BrowserPreferences>;
    savePreferences: (changes: Partial<BrowserPreferences>) => void;
    updatePlaybackPosition: (positionMs: number) => void;
  },
) {
  const assets = createPreviewAssets(dependencies.server, api, dependencies.selectedAtom);
  const assetView = useAtomValue(() => assets.view);
  const assetStatus = () => assetView().assetStatus;
  const thumbnailURL = () => assetView().thumbnailURL;
  const waveform = () => assetView().waveform;
  const assetRange = () => assetView().assetRange;
  const waveformVisible = () => dependencies.preferences().waveformVisible;
  const { registry, runtime } = dependencies.server;
  const state = Atom.keepAlive(
    Atom.make({
      mediaId: undefined as string | undefined,
      previewStatus: "",
      diagnostics: undefined as PreviewDiagnostics | undefined,
      playbackIntent: false,
      playbackMode: "whole-media" as PreviewPlaybackMode,
      orderedSegmentIndex: 0,
      boundedSegment: undefined as Segment | undefined,
      playing: false,
      ready: false,
    }),
  );
  const request = Atom.keepAlive(Atom.make({ center: 0, reload: 0 }));
  const attachment = Atom.keepAlive(Atom.make<HTMLVideoElement | undefined>(undefined));
  const observed = useAtomValue(() => state);
  const read = () => registry.get(state);
  const write = <K extends keyof Atom.Type<typeof state>>(
    key: K,
    value: Atom.Type<typeof state>[K],
  ) => registry.update(state, (s) => ({ ...s, [key]: value }));
  const previewStatus = () => observed().previewStatus;
  const diagnostics = () => read().diagnostics;
  const playbackIntent = () => read().playbackIntent;
  const playbackMode = () => read().playbackMode;
  const orderedSegmentIndex = () => read().orderedSegmentIndex;
  const boundedSegment = () => read().boundedSegment;
  const setPreviewStatus = (value: string) => write("previewStatus", value);
  const setDiagnostics = (value?: PreviewDiagnostics) => write("diagnostics", value);
  const setPlaybackIntent = (value: boolean) => write("playbackIntent", value);
  const setPlaybackMode = (value: PreviewPlaybackMode) => write("playbackMode", value);
  const setOrderedSegmentIndex = (value: number) => write("orderedSegmentIndex", value);
  const setBoundedSegment = (value?: Segment) => write("boundedSegment", value);
  const setPreviewCenterMs = (center: number) =>
    registry.update(request, (s) => ({ ...s, center }));
  const setPreviewReload = (f: (n: number) => number) =>
    registry.update(request, (s) => ({ ...s, reload: f(s.reload) }));
  const video = () => registry.get(attachment);
  const previewRenewalLeadMs = 1000;
  const loopSelectedSegment = () => dependencies.preferences().loopSelectedSegment;
  const stream = Atom.keepAlive(
    runtime.atom((get) => {
      const item = get(dependencies.selectedAtom);
      const player = get(attachment);
      const intent = get(request);
      let current = true;
      get.addFinalizer(() => {
        current = false;
      });
      return Effect.gen(function* () {
        registry.set(nativePlay, Atom.Interrupt);
        if (read().mediaId !== item?.id) {
          player?.pause();
          registry.set(state, {
            mediaId: item?.id,
            previewStatus: "",
            diagnostics: undefined,
            playbackIntent: false,
            playbackMode: "whole-media",
            orderedSegmentIndex: 0,
            boundedSegment: undefined,
            playing: false,
            ready: false,
          });
        }
        setDiagnostics();
        write("ready", false);
        write("playing", false);
        if (!item || !player || !canStreamPreview()) return;
        yield* Effect.sleep(200);
        setPreviewStatus("Loading preview…");
        const params = new URLSearchParams({
          centerMs: String(Math.round(intent.center)),
          beforeMs: "2000",
          afterMs: "6000",
        });
        yield* observePreviewPlayer(player, (event) => {
          if (!current) return;
          switch (event) {
            case "position":
              syncPreviewPosition(player.currentTime);
              break;
            case "ended":
              write("playing", false);
              handlePreviewEnded(player.currentTime);
              break;
            case "playing":
              write("playing", !player.paused);
              break;
            case "pause":
              write("playing", false);
              // Replacing an MSE source pauses while readiness is zero, not a user pause.
              if (!player.ended && player.readyState >= 2) setPlaybackIntent(false);
              break;
            case "ready":
              write("ready", player.readyState >= 2);
              break;
            case "waiting":
              write("playing", false);
              break;
            case "emptied":
              write("ready", false);
              write("playing", false);
              break;
            case "error":
              setPlaybackIntent(false);
              write("playing", false);
              setPreviewStatus("Preview data could not be played. Try again.");
          }
        });
        yield* streamPreview(
          player,
          previewMediaRequest(api, item.id, params),
          (value) => {
            if (current) {
              setDiagnostics(value);
              setPreviewStatus("");
            }
          },
          (error) => {
            if (current) {
              setPlaybackIntent(false);
              setPreviewStatus(error.message);
            }
          },
          () => current && playbackIntent(),
        );
      });
    }),
  );
  // Registry disposal owns the stream; player detach interrupts its native scope.
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
  const playDetectionPoint = (pointMs: number) => {
    const item = dependencies.selected();
    if (!canStreamPreview()) {
      setPreviewStatus(
        "Preview is unavailable in this browser. Use the timeline to seek to this point instead.",
      );
      return;
    }
    if (!item || !Number.isInteger(pointMs) || pointMs < 0 || pointMs > item.durationMs) {
      setPreviewStatus("That scene point has invalid playback bounds.");
      return;
    }
    const segment = {
      startMs: Math.max(0, pointMs - 2_000),
      endMs: Math.min(item.durationMs, pointMs + 2_000),
      label: "scene change",
      included: true,
    };
    if (segment.startMs >= segment.endMs) {
      setPreviewStatus("That scene point has invalid playback bounds.");
      return;
    }
    startPlayback("active-segment", pointMs, segment);
  };
  const seekDetectionPoint = (pointMs: number) => {
    const item = dependencies.selected();
    if (!item || !Number.isInteger(pointMs) || pointMs < 0 || pointMs > item.durationMs) {
      setPreviewStatus("That scene point has invalid playback bounds.");
      return;
    }
    setPlaybackIntent(false);
    setPlaybackMode("whole-media");
    setBoundedSegment();
    dependencies.updatePlaybackPosition(pointMs);
    restartPreview(pointMs);
  };
  const setLoopSelectedSegment = (enabled: boolean) => {
    dependencies.savePreferences({ loopSelectedSegment: enabled });
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
  const nativePlay = runtime.fn(
    (input: {
      player: HTMLVideoElement;
      requested: Atom.Type<typeof request>;
      mediaId: string | undefined;
    }) =>
      Effect.tryPromise({
        try: () => input.player.play(),
        catch: () =>
          new Error("Playback could not start. Wait for the preview to load and try again."),
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (
              video() === input.player &&
              registry.get(request) === input.requested &&
              dependencies.selected()?.id === input.mediaId
            ) {
              setPlaybackIntent(false);
              setPreviewStatus(error.message);
            }
          }),
        ),
      ),
  );
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
    if (player)
      registry.set(nativePlay, {
        player,
        requested: registry.get(request),
        mediaId: dependencies.selected()?.id,
      });
  };
  const pausePlayback = () => {
    setPlaybackIntent(false);
    video()?.pause();
  };
  const setWaveformVisibility = (visible: boolean) => {
    dependencies.savePreferences({ waveformVisible: visible });
  };
  const retryAssets = assets.retry;

  const command = <A extends unknown[]>(f: (...args: A) => void) => {
    const action = runtime.fn((args: A) => Effect.sync(() => f(...args)), { concurrent: true });
    return (...args: A) => registry.set(action, args);
  };
  registry.mount(nativePlay);
  registry.mount(stream);
  const requestedView = useAtomValue(() => request);
  const setVideo = command((player?: HTMLVideoElement) => {
    if (!player) {
      registry.set(nativePlay, Atom.Interrupt);
      setPlaybackIntent(false);
      write("playing", false);
      write("ready", false);
    }
    registry.set(attachment, player);
    registry.get(stream);
  });
  return {
    visibleRange: () => assetView().visibleRange,
    setVisibleRange: assets.setViewport,
    assetStatus,
    waveformVisible,
    setWaveformVisibility,
    retryAssets,
    previewStatus,
    thumbnailURL,
    waveform,
    assetRange,
    previewCenterMs: () => requestedView().center,
    setPreviewCenterMs: command(setPreviewCenterMs),
    diagnostics: () => observed().diagnostics,
    setDiagnostics: command(setDiagnostics),
    playbackMode: () => observed().playbackMode,
    playbackIntent: () => observed().playbackIntent,
    playing: () => observed().playing,
    ready: () => observed().ready,
    state,
    stream,
    playResult: nativePlay,
    loopSelectedSegment,
    setLoopSelectedSegment: command(setLoopSelectedSegment),
    toggleLoopSelectedSegment: command(toggleLoopSelectedSegment),
    watchedPosition,
    setVideo,
    togglePlayback: command(togglePlayback),
    pausePlayback: command(pausePlayback),
    playActiveSegment: command(playActiveSegment),
    playOrderedSegments: command(playOrderedSegments),
    playSegment: command(playSegment),
    playDetectionPoint: command(playDetectionPoint),
    seekDetectionPoint: command(seekDetectionPoint),
  };
}
