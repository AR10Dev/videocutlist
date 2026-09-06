import type { EditableProjectItem } from "../projects/model";
import { segmentIncluded, type Segment } from "../preview/model";

export type ExportSummary = {
  id: string;
  name: string;
  ranges: Segment[];
  duration: number;
  outputs: number;
  includedSegments: number;
  excludedSegments: number;
  filename: string;
  filenamePreviews: string[];
};

export function exportRanges(segments: Segment[], selection: string, duration: number): Segment[] {
  const included = segments.filter(segmentIncluded);
  if (selection !== "gaps") return included;
  const gaps: Segment[] = [];
  let cursor = 0;
  for (const segment of [...included].sort((a, b) => a.startMs - b.startMs)) {
    if (cursor < segment.startMs) gaps.push({ startMs: cursor, endMs: segment.startMs });
    cursor = Math.max(cursor, segment.endMs);
  }
  if (cursor < duration) gaps.push({ startMs: cursor, endMs: duration });
  return gaps;
}

const previewFilename = (
  template: string,
  source: string,
  segment: string,
  number: number,
  mode: string,
) =>
  (template || "{source}-{segment}.{ext}")
    .replaceAll("{source}", source.replace(/\.[^.]+$/, ""))
    .replaceAll("{segment}", segment || String(number))
    .replaceAll("{mode}", mode)
    .replaceAll("{ext}", "mkv");

export function summarizeExports(items: EditableProjectItem[]): ExportSummary[] {
  return items.map((item) => {
    const options = item.exportOptions;
    const sourceSegments = item.timeline.present.segments;
    const included = sourceSegments.filter(segmentIncluded);
    const ranges = exportRanges(
      sourceSegments,
      options.selection ?? "segments",
      item.media.durationMs,
    );
    const mode = options.mode ?? "merge";
    const filenameTemplate = options.filenameTemplate || "{source}-{segment}.{ext}";
    const filenamePreviews = ranges.slice(0, 5).map((range, index) => {
      const sourceIndex = sourceSegments.indexOf(range);
      const label =
        sourceIndex >= 0
          ? sourceSegments[sourceIndex].label?.trim() ||
            `Segment ${String(sourceIndex + 1).padStart(3, "0")}`
          : String(index + 1);
      return previewFilename(filenameTemplate, item.media.name, label, index + 1, mode);
    });
    return {
      id: item.id,
      name: item.media.name,
      ranges,
      duration: ranges.reduce((total, range) => total + range.endMs - range.startMs, 0),
      outputs: ranges.length ? (mode === "merge" ? 1 : ranges.length) : 0,
      includedSegments: included.length,
      excludedSegments: sourceSegments.length - included.length,
      filename: previewFilename(filenameTemplate, item.media.name, "1", 1, mode),
      filenamePreviews,
    };
  });
}
