import { createEffect } from "solid-js";
import type { AssetRange } from "../preview/assets";

type Props = {
  thumbnailURL?: string;
  waveform: number[];
  lane?: "thumbnail" | "waveform";
  durationMs: number;
  assetRange?: AssetRange;
};

export function TimelineCanvas(props: Props) {
  let canvas: HTMLCanvasElement | undefined;
  let drawVersion = 0;
  const draw = (
    thumbnailURL: string | undefined,
    waveformPeaks: number[] = [],
    assetRange?: AssetRange,
    durationMs = 0,
  ) => {
    const version = ++drawVersion;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(bounds.width * scale));
    canvas.height = Math.max(1, Math.round(bounds.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);
    const mediaDuration = Math.max(1, durationMs);
    const startMs = Math.max(0, Math.min(mediaDuration, assetRange?.startMs ?? 0));
    const rangeDuration = Math.max(
      0,
      Math.min(mediaDuration - startMs, assetRange?.durationMs ?? mediaDuration),
    );
    const left = (startMs / mediaDuration) * bounds.width;
    const width = (rangeDuration / mediaDuration) * bounds.width;
    const drawWaveform = () => {
      context.fillStyle = "rgba(96, 165, 250, 0.7)";
      const column = width / Math.max(1, waveformPeaks.length);
      waveformPeaks.forEach((peak, index) => {
        const height = Math.max(2, peak * bounds.height);
        context.fillRect(
          left + index * column,
          (bounds.height - height) / 2,
          Math.ceil(column),
          height,
        );
      });
    };
    if (props.lane === "waveform" || !thumbnailURL) {
      drawWaveform();
      return;
    }
    const image = new Image();
    image.onload = () => {
      if (version !== drawVersion) return;
      context.drawImage(image, left, 0, width, bounds.height);
      drawWaveform();
    };
    image.src = thumbnailURL;
  };
  createEffect(() => {
    draw(props.thumbnailURL, props.waveform, props.assetRange, props.durationMs);
  });
  return (
    <canvas
      class={props.lane === "waveform" ? "timeline-waveform-canvas" : "timeline-canvas"}
      ref={(element) => (canvas = element)}
      aria-hidden="true"
    />
  );
}
