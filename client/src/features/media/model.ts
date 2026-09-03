import type { components } from "../../generated/api";

export type Media = components["schemas"]["Media"];

type VideoStream = {
  codec?: unknown;
  width?: unknown;
  height?: unknown;
};

export function formatLibraryDuration(durationMs: number): string {
  const milliseconds = Math.max(0, Math.round(Number.isFinite(durationMs) ? durationMs : 0));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1_000) % 60;
  const fraction = milliseconds % 1_000;
  return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
}

const readableCodec = (codec: string) =>
  ({ h264: "H.264", avc: "H.264", hevc: "H.265", h265: "H.265", av1: "AV1" })[
    codec.toLowerCase()
  ] ?? codec.toUpperCase();

const readableContainer = (container: string) =>
  ({ mp4: "MP4", mov: "MOV", webm: "WebM", mkv: "Matroska" })[container.toLowerCase()] ?? container;

export function mediaSummary(media: Media): string {
  const video = media.streams?.video as VideoStream | undefined;
  const codec = typeof video?.codec === "string" ? readableCodec(video.codec) : "Unknown codec";
  const width = typeof video?.width === "number" ? video.width : 0;
  const height = typeof video?.height === "number" ? video.height : 0;
  const dimensions = width > 0 && height > 0 ? `${width}×${height}` : "dimensions unavailable";
  return `${readableContainer(media.container)} · ${codec} · ${dimensions}`;
}
