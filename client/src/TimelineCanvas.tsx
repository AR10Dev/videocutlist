import { createEffect } from "solid-js";

type Props = { thumbnailURL?: string; waveform: number[] };

export function TimelineCanvas(props: Props) {
  let canvas: HTMLCanvasElement | undefined;
  let drawVersion = 0;
  const draw = (thumbnailURL?: string, waveformPeaks: number[] = []) => {
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
    const drawWaveform = () => {
      context.fillStyle = "rgba(96, 165, 250, 0.7)";
      const column = bounds.width / Math.max(1, waveformPeaks.length);
      waveformPeaks.forEach((peak, index) => {
        const height = Math.max(2, peak * bounds.height);
        context.fillRect(index * column, (bounds.height - height) / 2, Math.ceil(column), height);
      });
    };
    if (!thumbnailURL) {
      drawWaveform();
      return;
    }
    const image = new Image();
    image.onload = () => {
      if (version !== drawVersion) return;
      context.drawImage(image, 0, 0, bounds.width, bounds.height);
      drawWaveform();
    };
    image.src = thumbnailURL;
  };
  createEffect(
    () => [props.thumbnailURL, props.waveform] as const,
    ([thumbnailURL, waveform]) => draw(thumbnailURL, waveform),
  );
  return <canvas class="timeline-canvas" ref={(element) => (canvas = element)} aria-hidden="true" />;
}
