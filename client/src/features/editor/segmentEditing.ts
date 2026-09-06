import { newSegmentId, type Segment } from "../preview/model";
import { validateSegments } from "../preview/model";

export const removeSegment = (segments: Segment[], index: number) =>
  segments.filter((_, current) => current !== index);

export const moveSegment = (segments: Segment[], index: number, direction: -1 | 1) => {
  const next = [...segments];
  const target = index + direction;
  if (target < 0 || target >= next.length) return segments;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};

export const resizeSegment = (
  segments: Segment[],
  index: number,
  boundary: "start" | "end",
  valueMs: number,
  durationMs: number,
) => {
  const segment = segments[index];
  if (!segment) return segments;
  const value = Math.max(0, Math.min(durationMs, Math.round(valueMs)));
  const replacement = {
    ...segment,
    startMs: boundary === "start" ? Math.min(value, segment.endMs - 1) : segment.startMs,
    endMs: boundary === "end" ? Math.max(value, segment.startMs + 1) : segment.endMs,
  };
  const next = segments.map((item, position) => (position === index ? replacement : item));
  return validateSegments(next, durationMs) ? segments : next;
};

export const resizeSegmentInteractive = (
  segments: Segment[],
  index: number,
  boundary: "start" | "end",
  valueMs: number,
  durationMs: number,
) => {
  const segment = segments[index];
  if (!segment) return segments;
  const ordered = segments
    .filter((_, position) => position !== index)
    .sort((a, b) => a.startMs - b.startMs);
  const previous = [...ordered].reverse().find((item) => item.endMs <= segment.startMs);
  const next = ordered.find((item) => item.startMs >= segment.endMs);
  const minimum = boundary === "start" ? (previous?.endMs ?? 0) : segment.startMs + 1;
  const maximum = boundary === "start" ? segment.endMs - 1 : (next?.startMs ?? durationMs);
  const value = Math.max(minimum, Math.min(maximum, Math.round(valueMs)));
  const replacement = {
    ...segment,
    startMs: boundary === "start" ? value : segment.startMs,
    endMs: boundary === "end" ? value : segment.endMs,
  };
  const updated = segments.map((item, position) => (position === index ? replacement : item));
  return validateSegments(updated, durationMs) ? segments : updated;
};

export const moveSegmentTo = (
  segments: Segment[],
  index: number,
  startMs: number,
  durationMs: number,
) => {
  const segment = segments[index];
  if (!segment) return segments;
  const length = segment.endMs - segment.startMs;
  const start = Math.max(0, Math.min(durationMs - length, Math.round(startMs)));
  const next = segments.map((item, position) =>
    position === index ? { ...item, startMs: start, endMs: start + length } : item,
  );
  return validateSegments(next, durationMs) ? segments : next;
};

export const splitSegment = (segments: Segment[], index: number, atMs: number) => {
  const segment = segments[index];
  const at = Math.round(atMs);
  if (!segment || at <= segment.startMs || at >= segment.endMs) return segments;
  return [
    ...segments.slice(0, index),
    { ...segment, endMs: at },
    {
      ...segment,
      startMs: at,
      ...(segment.id ? { id: newSegmentId() } : {}),
    },
    ...segments.slice(index + 1),
  ];
};
