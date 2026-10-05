import type * as EffectApiTypes from "../src/generated/effect-api";

export const mediaFixture: EffectApiTypes.Media = {
  id: "m_0123456789012345678901234567890123456789012",
  name: "camera.mp4",
  durationMs: 10_000,
  sizeBytes: 1000,
  container: "mp4",
  streams: {
    tracks: [
      { index: 0, type: "video", codec: "h264" },
      { index: 1, type: "audio", codec: "aac", language: "eng" },
      { index: 2, type: "subtitle", codec: "ass", language: "eng" },
    ],
  },
  etag: "v1",
};

export const secondMediaFixture: EffectApiTypes.Media = {
  ...mediaFixture,
  id: "m_second-012345678901234567890123456789012345",
  name: "second.mp4",
};

export function sseSnapshotFrame(id: string, snapshot: unknown): string {
  return `id: ${id}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
}
