import { createSignal, type JSX } from "solid-js";
import { Tooltip } from "@kobalte/core/tooltip";
import { frameDuration } from "../editor/frame";
import { Maximize2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-solid";
import { canStreamPreview, formatTime } from "./model";
import { useWorkspace } from "../app/WorkspaceContext";

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

export function PreviewPlayer() {
  const workspace = useWorkspace();
  const [aspectRatio, setAspectRatio] = createSignal("16 / 9");
  const [volume, setVolume] = createSignal(1);
  const [playing, setPlaying] = createSignal(false);
  let videoElement: HTMLVideoElement | undefined;

  const step = (direction: -1 | 1) => {
    const amount = frameDuration(workspace.selected()) || 1000;
    workspace.updateTimeline({
      playheadMs: Math.max(
        0,
        Math.min(workspace.duration(), workspace.playheadMs() + direction * amount),
      ),
    });
    workspace.markDirty();
  };
  const togglePlayback = () => {
    if (playing()) workspace.pausePlayback();
    else workspace.togglePlayback();
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
              workspace.setVideo(element);
            }}
            muted={workspace.muted()}
            aria-label="Preview player"
            data-preview-offset={workspace.diagnostics()?.offsetMs ?? 0}
            onLoadedMetadata={(event) => {
              const { videoWidth, videoHeight } = event.currentTarget;
              if (videoWidth && videoHeight) setAspectRatio(`${videoWidth} / ${videoHeight}`);
            }}
            onClick={workspace.togglePlayback}
            onDblClick={fullscreen}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onTimeUpdate={(event) => workspace.syncPreviewPosition(event.currentTarget.currentTime)}
            onSeeking={(event) => workspace.syncPreviewPosition(event.currentTarget.currentTime)}
            onSeeked={(event) => workspace.syncPreviewPosition(event.currentTarget.currentTime)}
          />
        ) : null}
        {!canStreamPreview() && (
          <p class="preview-overlay" role="status">
            Preview is unavailable in this browser. Use the timeline controls to set markers
            manually.
          </p>
        )}
        {workspace.previewStatus() && (
          <p class="preview-overlay" role="status">
            {workspace.previewStatus()}
          </p>
        )}
      </div>
      <p class="preview-range" aria-label="Preview source range">
        {workspace.diagnostics()
          ? `Preview: ${formatTime(workspace.diagnostics()!.startMs, workspace.duration())} to ${formatTime(
              workspace.diagnostics()!.startMs + workspace.diagnostics()!.durationMs,
              workspace.duration(),
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
          {formatTime(workspace.playheadMs(), workspace.duration())} /{" "}
          {formatTime(workspace.duration(), workspace.duration())}
        </span>
        <input
          type="range"
          aria-label="Preview scrubber"
          min="0"
          max={workspace.duration()}
          step="1"
          value={workspace.playheadMs()}
          onInput={(event) => {
            workspace.updateTimeline({ playheadMs: Number(event.currentTarget.value) });
            workspace.markDirty();
          }}
        />
        <IconButton
          label={workspace.muted() ? "Unmute preview" : "Mute preview"}
          pressed={workspace.muted()}
          onClick={() => {
            const muted = !workspace.muted();
            workspace.setMuted(muted);
            workspace.saveSettings({ muted });
            workspace.markDirty();
          }}
        >
          {workspace.muted() ? (
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
