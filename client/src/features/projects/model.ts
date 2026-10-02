import type * as EffectApiTypes from "../../generated/effect-api";
import { createTimelineHistory, type TimelineHistory } from "../editor/timeline";
import { normalizeSegments } from "../preview/model";

export type Media = EffectApiTypes.Media;
export type Project = EffectApiTypes.Project;
export type ProjectItem = EffectApiTypes.Project["items"][number];
export type ProjectExportOptions = EffectApiTypes.Project["items"][number]["exportOptions"];
export type ExportContainer = NonNullable<ProjectExportOptions["container"]>;

export type EditableProjectItem = {
  id: string;
  media: Media;
  timeline: TimelineHistory;
  muted: boolean;
  exportOptions: {
    mode?: ProjectExportOptions["mode"];
    selection?: ProjectExportOptions["selection"];
    streamIndexes?: number[];
    cutStrategy?: ProjectExportOptions["cutStrategy"];
    container?: ProjectExportOptions["container"];
    destinationId?: string;
    filenameTemplate?: string;
  };
};

export const newProjectItemId = () => `i_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

export const createProjectItem = (media: Media, destinationId?: string): EditableProjectItem => ({
  id: newProjectItemId(),
  media,
  timeline: createTimelineHistory({
    playheadMs: 0,
    segments: [],
    zoom: 1,
  }),
  muted: false,
  exportOptions: {
    mode: "separate",
    selection: "segments",
    cutStrategy: "stream_copy_preferred",
    container: "mkv",
    ...(destinationId ? { destinationId } : {}),
  },
});

export const restoreProjectItem = (item: ProjectItem, media: Media): EditableProjectItem => {
  const editor = item.editorState ?? { playheadMs: 0, zoom: 1, muted: false };
  const { streamIndexes, ...exportOptions } = item.exportOptions;
  return {
    id: item.id,
    media,
    timeline: createTimelineHistory({
      playheadMs: editor.playheadMs,
      segments: normalizeSegments(
        item.segments.map((segment) => ({ ...segment })),
        item.id,
      ),
      zoom: editor.zoom,
    }),
    muted: editor.muted,
    exportOptions: {
      ...exportOptions,
      ...(streamIndexes ? { streamIndexes: [...streamIndexes] } : {}),
    },
  };
};

export const serializeProjectItem = (item: EditableProjectItem): ProjectItem => ({
  id: item.id,
  mediaId: item.media.id,
  segments: normalizeSegments(item.timeline.present.segments, item.id),
  editorState: {
    playheadMs: Number.isFinite(item.timeline.present.playheadMs)
      ? Math.max(0, Math.min(Math.round(item.timeline.present.playheadMs), item.media.durationMs))
      : 0,
    zoom:
      Number.isFinite(item.timeline.present.zoom) && item.timeline.present.zoom > 0
        ? item.timeline.present.zoom
        : 1,
    muted: item.muted,
  },
  exportOptions: {
    ...item.exportOptions,
    ...(item.exportOptions.streamIndexes
      ? { streamIndexes: [...item.exportOptions.streamIndexes] }
      : {}),
  },
});

export const moveProjectItem = (
  items: EditableProjectItem[],
  id: string,
  direction: -1 | 1,
): EditableProjectItem[] => {
  const index = items.findIndex((item) => item.id === id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= items.length) return items;
  const result = [...items];
  [result[index], result[next]] = [result[next], result[index]];
  return result;
};
