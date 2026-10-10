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

export const settingsFixture = {
  revision: 1,
  schemaVersion: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  pathsConstrained: false,
  roots: { media: { state: "ready" } },
  settings: {
    destinations: [{ id: "download", label: "Downloads", kind: "download", retention: "24h" }],
    exportLimit: 1,
    cacheMaxBytes: 1_000_000,
    previewGlobalLimit: 2,
    previewBeforeMs: 1000,
    previewAfterMs: 1000,
    previewMaxMs: 5000,
    previewGridMs: 1000,
    mediaMaxFiles: 100,
    mediaMaxDepth: 4,
    mcpEnabled: false,
  },
} satisfies EffectApiTypes.SettingsResponse;

export function deferred<A = void>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export function sseSnapshotFrame(id: string, snapshot: unknown): string {
  return `id: ${id}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
}
