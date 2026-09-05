import type { EditableProjectItem } from "../projects/model";
import type { Segment } from "../preview/model";

export function exportRanges(segments: Segment[], selection: string, duration: number): Segment[] {
  if (selection !== "gaps") return segments;
  const gaps: Segment[] = [];
  let cursor = 0;
  for (const segment of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    if (cursor < segment.startMs) gaps.push({ startMs: cursor, endMs: segment.startMs });
    cursor = Math.max(cursor, segment.endMs);
  }
  if (cursor < duration) gaps.push({ startMs: cursor, endMs: duration });
  return gaps;
}

export function summarizeExports(items: EditableProjectItem[]) {
  return items.map((item) => {
    const options = item.exportOptions;
    const ranges = exportRanges(
      item.timeline.present.segments,
      options.selection ?? "segments",
      item.media.durationMs,
    );
    const mode = options.mode ?? "merge";
    return {
      id: item.id,
      name: item.media.name,
      ranges,
      duration: ranges.reduce((total, range) => total + range.endMs - range.startMs, 0),
      outputs: ranges.length ? (mode === "merge" ? 1 : ranges.length) : 0,
      filename: (options.filenameTemplate || "{source}-{segment}.{ext}")
        .replaceAll("{source}", item.media.name.replace(/\.[^.]+$/, ""))
        .replaceAll("{segment}", "1")
        .replaceAll("{mode}", mode)
        .replaceAll("{ext}", "mkv"),
    };
  });
}
