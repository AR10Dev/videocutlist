import { createSignal, onCleanup, type JSX } from "solid-js";
import { Tooltip } from "@kobalte/core/tooltip";
import { frameDuration } from "../editor/frame";
import {
  ChevronsLeft,
  ChevronsRight,
  List,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-solid";
import { canStreamPreview, segmentIncluded } from "./model";
import { useWorkspace } from "../app/WorkspaceContext";

type IconButtonProps = {
  label: string;
  children: JSX.Element;
  pressed?: boolean;
  disabled?: boolean;
  keyshortcuts?: string;
  onClick: () => void;
};

function IconButton(props: IconButtonProps) {
  return (
    <Tooltip openDelay={120} closeDelay={0}>
      <Tooltip.Trigger
        class="btn btn-ghost btn-sm btn-square"
        type="button"
        aria-label={props.label}
        aria-pressed={props.pressed}
        aria-keyshortcuts={props.keyshortcuts}
        onClick={props.onClick}
        disabled={props.disabled}
      >
        {props.children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content class="tooltip-content">{props.label}</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  );
}

export function PreviewPlayer(props: { timeline: JSX.Element }) {
  const workspace = useWorkspace();
  const [aspectRatio, setAspectRatio] = createSignal("16 / 9");
  const [volume, setVolume] = createSignal(1);
  let videoElement: HTMLVideoElement | undefined;
  let settlingSeek = false;
  onCleanup(() => {
    workspace.pausePlayback();
    workspace.setVideo(undefined);
  });

  const step = (direction: -1 | 1) => {
    const amount = frameDuration(workspace.selected()) || 1000;
    workspace.updateTimeline({
      playheadMs: Math.max(
        0,
        Math.min(workspace.duration(), workspace.playheadMs() + direction * amount),
      ),
    });
  };
  const togglePlayback = () => workspace.togglePlayback();
  const fullscreen = () => {
    const request = !document.fullscreenElement
      ? videoElement?.requestFullscreen?.()
      : document.exitFullscreen?.();
    void request?.catch(() =>
      workspace.setEditorStatus("Fullscreen is unavailable. Check your browser permissions."),
    );
  };
  const jumpToCut = (direction: -1 | 1) => {
    const cuts = workspace
      .present()
      .segments.filter(segmentIncluded)
      .sort((a, b) => a.startMs - b.startMs);
    const position = workspace.playheadMs();
    const target =
      direction < 0
        ? [...cuts].reverse().find((cut) => cut.startMs < position)?.startMs
        : cuts.find((cut) => cut.startMs > position)?.startMs;
    workspace.updateTimeline({ playheadMs: target ?? (direction < 0 ? 0 : workspace.duration()) });
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
              workspace.setPreviewCenterMs(workspace.playheadMs());
              workspace.setVideo(element);
            }}
            muted={workspace.muted()}
            aria-label="Preview player"
            data-preview-offset={workspace.diagnostics()?.offsetMs ?? 0}
            data-playback-mode={workspace.playbackMode()}
            data-playback-intent={workspace.playbackIntent() ? "playing" : "paused"}
            onLoadedMetadata={(event) => {
              const { videoWidth, videoHeight } = event.currentTarget;
              if (videoWidth && videoHeight) setAspectRatio(`${videoWidth} / ${videoHeight}`);
            }}
            onClick={workspace.togglePlayback}
            onDblClick={fullscreen}
            onEnded={(event) => {
              workspace.handlePreviewEnded(event.currentTarget.currentTime);
            }}
            onTimeUpdate={(event) => {
              if (!settlingSeek) workspace.syncPreviewPosition(event.currentTarget.currentTime);
            }}
            onSeeking={() => (settlingSeek = true)}
            onSeeked={() => (settlingSeek = false)}
          />
        ) : null}
        {!canStreamPreview() && (
          <p class="preview-overlay" role="status">
            Preview is unavailable in this browser. Use the I and O keyboard shortcuts to set
            markers manually.
          </p>
        )}
        {workspace.previewStatus() && (
          <p class="preview-overlay" role="status">
            {workspace.previewStatus()}
          </p>
        )}
      </div>
      <div class="edit-deck">
        <div class="control-rail" role="toolbar" aria-label="Editor controls">
          <div class="preview-controls" aria-label="Playback and audio controls">
            <span class="sr-only" role="status" aria-live="polite">
              {workspace.playbackIntent()
                ? workspace.playbackMode() === "whole-media"
                  ? "Playing whole media"
                  : workspace.playbackMode() === "ordered-segments"
                    ? "Playing selected segments in order"
                    : workspace.playbackMode() === "active-segment-loop"
                      ? "Looping selected segment"
                      : "Playing selected segment"
                : "Preview paused"}
            </span>
            <IconButton label="Previous cut" onClick={() => jumpToCut(-1)}>
              <ChevronsLeft size={18} aria-hidden="true" />
            </IconButton>
            <IconButton label="Previous preview step" keyshortcuts="," onClick={() => step(-1)}>
              <SkipBack size={18} aria-hidden="true" />
            </IconButton>
            <IconButton
              label={workspace.playbackIntent() ? "Pause preview" : "Play preview"}
              keyshortcuts="Space"
              disabled={!canStreamPreview()}
              onClick={togglePlayback}
            >
              {workspace.playbackIntent() ? (
                <Pause size={22} aria-hidden="true" />
              ) : (
                <Play size={22} aria-hidden="true" />
              )}
            </IconButton>
            <IconButton label="Next preview step" keyshortcuts="." onClick={() => step(1)}>
              <SkipForward size={18} aria-hidden="true" />
            </IconButton>
            <IconButton label="Next cut" onClick={() => jumpToCut(1)}>
              <ChevronsRight size={18} aria-hidden="true" />
            </IconButton>
            <IconButton
              label="Play selected segment"
              keyshortcuts="P"
              disabled={!workspace.activeSegment() || !canStreamPreview()}
              onClick={() => workspace.playActiveSegment(false)}
            >
              <Play size={18} aria-hidden="true" />
            </IconButton>
            <IconButton
              label="Preview selected segments"
              keyshortcuts="R"
              disabled={!workspace.present().segments.length || !canStreamPreview()}
              onClick={workspace.playOrderedSegments}
            >
              <List size={18} aria-hidden="true" />
            </IconButton>
            <div class="volume-control" aria-label="Preview audio">
              <IconButton
                label={workspace.muted() ? "Unmute preview" : "Mute preview"}
                pressed={workspace.muted()}
                disabled={!canStreamPreview()}
                onClick={() => {
                  const muted = !workspace.muted();
                  workspace.setMuted(muted);
                  workspace.saveSettings({ muted });
                }}
              >
                {workspace.muted() ? (
                  <VolumeX size={18} aria-hidden="true" />
                ) : (
                  <Volume2 size={18} aria-hidden="true" />
                )}
              </IconButton>
              <input
                class="range range-xs"
                type="range"
                aria-label="Preview volume"
                title="Preview volume"
                disabled={!canStreamPreview()}
                min="0"
                max="1"
                step="0.05"
                value={volume()}
                onInput={(event) => {
                  setVolumeValue(Number(event.currentTarget.value));
                  if (workspace.muted()) {
                    workspace.setMuted(false);
                    workspace.saveSettings({ muted: false });
                  }
                }}
              />
            </div>
          </div>
        </div>
      </div>
      {props.timeline}
    </div>
  );
}
