import { createSignal, type Accessor, type JSX } from "solid-js";
import { Tooltip } from "@kobalte/core/tooltip";
import { frameDuration } from "../editor/frame";
import { Maximize2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-solid";
import { canStreamPreview, formatTime } from "./model";
import type { Media } from "./model";

export interface PreviewPlayerProps {
  selected: Accessor<Media | undefined>;
  duration: Accessor<number>;
  playheadMs: Accessor<number>;
  muted: Accessor<boolean>;
  previewStatus: Accessor<string>;
  diagnostics: Accessor<{ startMs: number; durationMs: number; offsetMs: number } | undefined>;
  setMuted: (muted: boolean) => void;
  saveSettings: (settings: { muted: boolean }) => void;
  setVideo: (video: HTMLVideoElement) => void;
  syncPreviewPosition: (seconds: number) => void;
  togglePlayback: () => void;
  updateTimeline: (changes: { playheadMs: number }) => void;
  markDirty: () => void;
}

type IconButtonProps = {
  label: string;
  children: JSX.Element;
  pressed?: boolean;
  keyshortcuts?: string;
  onClick: () => void;
};

function IconButton(props: IconButtonProps) {
  return (
    <Tooltip openDelay={120} closeDelay={0}>
      <Tooltip.Trigger
        type="button"
        aria-label={props.label}
        aria-pressed={props.pressed}
        aria-keyshortcuts={props.keyshortcuts}
        onClick={props.onClick}
      >
        {props.children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content class="tooltip-content">{props.label}</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  );
}

export function PreviewPlayer(props: PreviewPlayerProps) {
  const [aspectRatio, setAspectRatio] = createSignal("16 / 9");
  const [volume, setVolume] = createSignal(1);
  const [playing, setPlaying] = createSignal(false);
  let videoElement: HTMLVideoElement | undefined;

  const step = (direction: -1 | 1) => {
    const amount = frameDuration(props.selected()) || 1000;
    props.updateTimeline({
      playheadMs: Math.max(0, Math.min(props.duration(), props.playheadMs() + direction * amount)),
    });
    props.markDirty();
  };
  const togglePlayback = () => {
    if (playing()) videoElement?.pause();
    else props.togglePlayback();
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
            data-preview-offset={props.diagnostics()?.offsetMs ?? 0}
            onLoadedMetadata={(event) => {
              const { videoWidth, videoHeight } = event.currentTarget;
              if (videoWidth && videoHeight) setAspectRatio(`${videoWidth} / ${videoHeight}`);
            }}
            onClick={props.togglePlayback}
            onDblClick={fullscreen}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
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
      <p class="preview-range" aria-label="Preview source range">
        {props.diagnostics()
          ? `Preview: ${formatTime(props.diagnostics()!.startMs, props.duration())} to ${formatTime(
              props.diagnostics()!.startMs + props.diagnostics()!.durationMs,
              props.duration(),
            )}`
          : "\u00a0"}
      </p>
      <div class="preview-controls" aria-label="Preview controls">
        <IconButton
          label={playing() ? "Pause preview" : "Play preview"}
          keyshortcuts="Space"
          onClick={togglePlayback}
        >
          {playing() ? (
            <Pause size={18} aria-hidden="true" />
          ) : (
            <Play size={18} aria-hidden="true" />
          )}
        </IconButton>
        <IconButton label="Previous frame" keyshortcuts="ArrowLeft" onClick={() => step(-1)}>
          <SkipBack size={18} aria-hidden="true" />
        </IconButton>
        <IconButton label="Next frame" keyshortcuts="ArrowRight" onClick={() => step(1)}>
          <SkipForward size={18} aria-hidden="true" />
        </IconButton>
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
        <IconButton
          label={props.muted() ? "Unmute preview" : "Mute preview"}
          pressed={props.muted()}
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
        </IconButton>
        <input
          type="range"
          aria-label="Preview volume"
          min="0"
          max="1"
          step="0.05"
          value={volume()}
          onInput={(event) => setVolumeValue(Number(event.currentTarget.value))}
        />
        <IconButton label="Fullscreen preview" onClick={fullscreen}>
          <Maximize2 size={18} aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  );
}
