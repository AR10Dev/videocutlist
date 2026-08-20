import type { Segment } from "./preview";

export const removeSegment = (segments: Segment[], index: number) =>
  segments.filter((_, current) => current !== index);

export const moveSegment = (segments: Segment[], index: number, direction: -1 | 1) => {
  const next = [...segments];
  const target = index + direction;
  if (target < 0 || target >= next.length) return segments;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};
