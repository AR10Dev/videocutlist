import type { components } from "../../generated/api";
import { createTimelineHistory, type TimelineHistory } from "../editor/timeline";
import { normalizeSegments } from "../preview/model";

export type Media = components["schemas"]["Media"];
export type Project = components["schemas"]["Project"];
export type ProjectItem = components["schemas"]["ProjectItem"];
export type ProjectExportOptions = components["schemas"]["ProjectExportOptions"];
export type ExportContainer = NonNullable<ProjectExportOptions["container"]>;

export type EditableProjectItem = {
  id: string;
  media: Media;
  timeline: TimelineHistory;
  muted: boolean;
  exportOptions: ProjectExportOptions;
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
  return {
    id: item.id,
    media,
    timeline: createTimelineHistory({
      playheadMs: editor.playheadMs,
      segments: normalizeSegments(item.segments, item.id),
      zoom: editor.zoom,
    }),
    muted: editor.muted,
    exportOptions: item.exportOptions,
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
  exportOptions: item.exportOptions,
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
