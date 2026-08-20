import type { Segment } from "./preview";

export type TimelineSnapshot = {
  playheadMs: number;
  inMs: number;
  outMs: number;
  segments: Segment[];
  zoom: number;
};

export type TimelineHistory = {
  present: TimelineSnapshot;
  past: TimelineSnapshot[];
  future: TimelineSnapshot[];
};

const sameSnapshot = (a: TimelineSnapshot, b: TimelineSnapshot) =>
  a.playheadMs === b.playheadMs &&
  a.inMs === b.inMs &&
  a.outMs === b.outMs &&
  a.zoom === b.zoom &&
  JSON.stringify(a.segments) === JSON.stringify(b.segments);

const copy = (snapshot: TimelineSnapshot): TimelineSnapshot => ({
  ...snapshot,
  segments: snapshot.segments.map((segment) => ({ ...segment })),
});

export const createTimelineHistory = (
  initial: TimelineSnapshot,
): TimelineHistory => ({ present: copy(initial), past: [], future: [] });

export const editTimeline = (
  history: TimelineHistory,
  changes: Partial<TimelineSnapshot>,
): TimelineHistory => {
  const next = copy({ ...history.present, ...changes });
  if (sameSnapshot(next, history.present)) return history;
  return { present: next, past: [...history.past, copy(history.present)], future: [] };
};

export const undoTimeline = (history: TimelineHistory): TimelineHistory => {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    present: copy(previous),
    past: history.past.slice(0, -1),
    future: [copy(history.present), ...history.future],
  };
};

export const redoTimeline = (history: TimelineHistory): TimelineHistory => {
  const next = history.future[0];
  if (!next) return history;
  return {
    present: copy(next),
    past: [...history.past, copy(history.present)],
    future: history.future.slice(1),
  };
};

export const resetTimelineHistory = (
  snapshot: TimelineSnapshot,
): TimelineHistory => createTimelineHistory(snapshot);

export const canUndoTimeline = (history: TimelineHistory) =>
  history.past.length > 0;
export const canRedoTimeline = (history: TimelineHistory) =>
  history.future.length > 0;
