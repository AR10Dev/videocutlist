import type { components } from "../../generated/api";
import type { Segment } from "../preview/model";

export type DetectionKind = components["schemas"]["DetectionInput"]["kind"];
export type RangeCandidate = components["schemas"]["DetectionRangeCandidate"];
export type Candidate = components["schemas"]["DetectionCandidate"];
export type DetectionProject = {
  id: string;
  mediaId: string;
  revision: number;
  segments: Segment[];
};

type CandidateFields = {
  startMs?: unknown;
  endMs?: unknown;
  pointMs?: unknown;
};

export type CandidateSkipReason = "stale" | "invalid" | "overlap" | "point";
export type SkippedCandidate = {
  candidate: Candidate;
  reason: CandidateSkipReason;
};

export type CandidateAcceptance = {
  segments: Segment[];
  accepted: RangeCandidate[];
  skipped: SkippedCandidate[];
};

const validSources = new Set<DetectionKind>(["silence", "black", "scene"]);
const fieldsOf = (candidate: Candidate) => candidate as CandidateFields;

/** Return a scene point, including the one-millisecond shape used by old jobs. */
export function candidatePointMs(candidate: Candidate): number | undefined {
  if (candidate.source !== "scene") return undefined;
  const fields = fieldsOf(candidate);
  if (Number.isInteger(fields.pointMs)) return fields.pointMs as number;
  if (
    Number.isInteger(fields.startMs) &&
    Number.isInteger(fields.endMs) &&
    (fields.endMs as number) - (fields.startMs as number) === 1
  )
    return fields.startMs as number;
  return undefined;
}

export function candidateRange(
  candidate: Candidate,
): { startMs: number; endMs: number } | undefined {
  if (candidate.source === "scene") return undefined;
  const fields = fieldsOf(candidate);
  if (!Number.isInteger(fields.startMs) || !Number.isInteger(fields.endMs)) return undefined;
  return { startMs: fields.startMs as number, endMs: fields.endMs as number };
}

export function candidateSkipReason(
  candidate: Candidate,
  project: DetectionProject,
  durationMs: number,
): CandidateSkipReason | undefined {
  if (
    candidate.projectId !== project.id ||
    candidate.mediaId !== project.mediaId ||
    candidate.projectRevision !== project.revision
  )
    return "stale";
  if (!candidate.id || !validSources.has(candidate.source)) return "invalid";
  if (candidate.source === "scene")
    return candidatePointMs(candidate) === undefined ? "invalid" : "point";
  const range = candidateRange(candidate);
  if (
    !range ||
    range.startMs < 0 ||
    range.startMs >= range.endMs ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    range.endMs > durationMs
  )
    return "invalid";
  return undefined;
}

const overlaps = (
  candidate: { startMs: number; endMs: number },
  segment: { startMs: number; endMs: number },
) => candidate.startMs < segment.endMs && segment.startMs < candidate.endMs;

const sortStart = (candidate: Candidate) =>
  candidateRange(candidate)?.startMs ?? candidatePointMs(candidate) ?? Number.MAX_SAFE_INTEGER;

export function acceptCandidates(
  candidates: Candidate[],
  project: DetectionProject,
  durationMs: number,
): CandidateAcceptance {
  const accepted: RangeCandidate[] = [];
  const skippedWithIndex: { skipped: SkippedCandidate; index: number }[] = [];
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => sortStart(a.candidate) - sortStart(b.candidate) || a.index - b.index);

  for (const { candidate, index } of ordered) {
    const reason = candidateSkipReason(candidate, project, durationMs);
    if (reason) {
      skippedWithIndex.push({ skipped: { candidate, reason }, index });
      continue;
    }
    const range = candidateRange(candidate);
    if (!range) {
      skippedWithIndex.push({ skipped: { candidate, reason: "invalid" }, index });
      continue;
    }
    if (
      project.segments.some((segment) => overlaps(range, segment)) ||
      accepted.some((item) => overlaps(range, item))
    ) {
      skippedWithIndex.push({ skipped: { candidate, reason: "overlap" }, index });
      continue;
    }
    accepted.push(candidate as RangeCandidate);
  }

  const skipped = skippedWithIndex.sort((a, b) => a.index - b.index).map(({ skipped }) => skipped);
  const segments = [
    ...project.segments,
    ...accepted.map((candidate) => ({
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      label: candidate.source,
      included: true,
    })),
  ].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return { segments, accepted, skipped };
}

export function acceptCandidate(
  candidate: Candidate,
  project: DetectionProject,
  durationMs: number,
) {
  const result = acceptCandidates([candidate], project, durationMs);
  return result.accepted.length ? { ...project, segments: result.segments } : null;
}

export function skippedCandidateSummary(skipped: SkippedCandidate[]) {
  const counts = new Map<CandidateSkipReason, number>();
  for (const { reason } of skipped) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const labels: [CandidateSkipReason, string][] = [
    ["stale", "stale"],
    ["invalid", "invalid"],
    ["overlap", "overlapping"],
    ["point", "scene points"],
  ];
  return labels
    .filter(([reason]) => counts.has(reason))
    .map(([reason, label]) => `${counts.get(reason)} ${label}`)
    .join(", ");
}
