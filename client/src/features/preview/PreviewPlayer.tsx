import { createSignal, type Accessor } from "solid-js";
import { frameDuration } from "../editor/frame";
import { Maximize2, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-solid";
import { canStreamPreview, formatTime } from "./model";
import type { Media } from "./model";

export interface PreviewPlayerProps {
  selected: Accessor<Media | undefined>;
  duration: Accessor<number>;
  playheadMs: Accessor<number>;
  muted: Accessor<boolean>;
  previewStatus: Accessor<string>;
  diagnostics: Accessor<{ startMs: number } | undefined>;
  setMuted: (muted: boolean) => void;
  saveSettings: (settings: { muted: boolean }) => void;
  setVideo: (video: HTMLVideoElement) => void;
  syncPreviewPosition: (seconds: number) => void;
  togglePlayback: () => void;
  updateTimeline: (changes: { playheadMs: number }) => void;
  markDirty: () => void;
}

export function PreviewPlayer(props: PreviewPlayerProps) {
  const [aspectRatio, setAspectRatio] = createSignal("16 / 9");
  const [volume, setVolume] = createSignal(1);
  let videoElement: HTMLVideoElement | undefined;

  const step = (direction: -1 | 1) => {
    const amount = frameDuration(props.selected()) || 1000;
    props.updateTimeline({
      playheadMs: Math.max(0, Math.min(props.duration(), props.playheadMs() + direction * amount)),
    });
    props.markDirty();
  };
  const fullscreen = () => {
    if (!document.fullscreenElement) void videoElement?.requestFullscreen?.();
    else void document.exitFullscreen?.();
  };
  const setVolumeValue = (value: number) => {
    setVolume(value);
    if (videoElement) videoElement.volume = value;
  };

  return (
    <div class="preview-player">
      <div class="preview-surface" style={`aspect-ratio: ${aspectRatio()};`}>
        {canStreamPreview() ? (
          <video
            ref={(element) => {
              videoElement = element;
              props.setVideo(element);
            }}
            muted={props.muted()}
            aria-label="Preview player"
            data-preview-offset={props.diagnostics()?.startMs ?? 0}
            onLoadedMetadata={(event) => {
              const { videoWidth, videoHeight } = event.currentTarget;
              if (videoWidth && videoHeight) setAspectRatio(`${videoWidth} / ${videoHeight}`);
            }}
            onClick={props.togglePlayback}
            onDblClick={fullscreen}
            onTimeUpdate={(event) => props.syncPreviewPosition(event.currentTarget.currentTime)}
            onSeeking={(event) => props.syncPreviewPosition(event.currentTarget.currentTime)}
            onSeeked={(event) => props.syncPreviewPosition(event.currentTarget.currentTime)}
          />
        ) : null}
        {!canStreamPreview() && (
          <p class="preview-overlay" role="status">
            Preview is unavailable in this browser. Use the timeline controls to set markers
            manually.
          </p>
        )}
        {props.previewStatus() && (
          <p class="preview-overlay" role="status">
            {props.previewStatus()}
          </p>
        )}
      </div>
      <div class="preview-controls" aria-label="Preview controls">
        <button
          type="button"
          aria-label="Play / pause preview"
          title="Play / pause preview"
          aria-keyshortcuts="Space"
          onClick={props.togglePlayback}
        >
          <Play size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Previous frame"
          title="Previous frame"
          aria-keyshortcuts="ArrowLeft"
          onClick={() => step(-1)}
        >
          <SkipBack size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Next frame"
          title="Next frame"
          aria-keyshortcuts="ArrowRight"
          onClick={() => step(1)}
        >
          <SkipForward size={18} aria-hidden="true" />
        </button>
        <span class="preview-time" aria-live="off">
          {formatTime(props.playheadMs(), props.duration())} /{" "}
          {formatTime(props.duration(), props.duration())}
        </span>
        <input
          type="range"
          aria-label="Preview scrubber"
          min="0"
          max={props.duration()}
          step="1"
          value={props.playheadMs()}
          onInput={(event) => {
            props.updateTimeline({ playheadMs: Number(event.currentTarget.value) });
            props.markDirty();
          }}
        />
        <button
          type="button"
          aria-label={props.muted() ? "Unmute preview" : "Mute preview"}
          title={props.muted() ? "Unmute preview" : "Mute preview"}
          aria-pressed={props.muted()}
          onClick={() => {
            const muted = !props.muted();
            props.setMuted(muted);
            props.saveSettings({ muted });
            props.markDirty();
          }}
        >
          {props.muted() ? (
            <VolumeX size={18} aria-hidden="true" />
          ) : (
            <Volume2 size={18} aria-hidden="true" />
          )}
        </button>
        <input
          type="range"
          aria-label="Preview volume"
          min="0"
          max="1"
          step="0.05"
          value={volume()}
          onInput={(event) => setVolumeValue(Number(event.currentTarget.value))}
        />
        <button
          type="button"
          aria-label="Fullscreen preview"
          title="Fullscreen preview"
          onClick={fullscreen}
        >
          <Maximize2 size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
