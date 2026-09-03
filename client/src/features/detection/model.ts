import type { components } from "../../generated/api";

export type DetectionKind = components["schemas"]["DetectionInput"]["kind"];
export type Candidate = components["schemas"]["DetectionCandidate"];
export function acceptCandidate(
  candidate: Candidate,
  project: {
    id: string;
    mediaId: string;
    revision: number;
    segments: { startMs: number; endMs: number; label?: string }[];
  },
  durationMs: number,
) {
  if (
    candidate.projectId !== project.id ||
    candidate.mediaId !== project.mediaId ||
    candidate.projectRevision !== project.revision ||
    candidate.startMs < 0 ||
    candidate.startMs >= candidate.endMs ||
    candidate.endMs > durationMs ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  )
    return null;
  if (
    project.segments.some(
      (segment) => candidate.startMs < segment.endMs && segment.startMs < candidate.endMs,
    )
  )
    return null;
  return {
    ...project,
    segments: [
      ...project.segments,
      { startMs: candidate.startMs, endMs: candidate.endMs, label: candidate.source },
    ].sort((a, b) => a.startMs - b.startMs),
  };
}
