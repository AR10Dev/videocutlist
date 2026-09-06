import type { components } from "../../generated/api";

export type DetectionKind = components["schemas"]["DetectionInput"]["kind"];
export type Candidate = components["schemas"]["DetectionCandidate"];
export type DetectionProject = {
  id: string;
  mediaId: string;
  revision: number;
  segments: { startMs: number; endMs: number; label?: string }[];
};

export type CandidateSkipReason = "stale" | "invalid" | "overlap";
export type SkippedCandidate = {
  candidate: Candidate;
  reason: CandidateSkipReason;
};

export type CandidateAcceptance = {
  segments: DetectionProject["segments"];
  accepted: Candidate[];
  skipped: SkippedCandidate[];
};

const validSources = new Set<DetectionKind>(["silence", "black", "scene"]);

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
  if (
    !candidate.id ||
    !validSources.has(candidate.source) ||
    !Number.isInteger(candidate.startMs) ||
    !Number.isInteger(candidate.endMs) ||
    candidate.startMs < 0 ||
    candidate.startMs >= candidate.endMs ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    candidate.endMs > durationMs ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  )
    return "invalid";
  return undefined;
}

const overlaps = (
  candidate: { startMs: number; endMs: number },
  segment: { startMs: number; endMs: number },
) => candidate.startMs < segment.endMs && segment.startMs < candidate.endMs;

export function acceptCandidates(
  candidates: Candidate[],
  project: DetectionProject,
  durationMs: number,
): CandidateAcceptance {
  const accepted: Candidate[] = [];
  const skippedWithIndex: { skipped: SkippedCandidate; index: number }[] = [];
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => a.candidate.startMs - b.candidate.startMs || a.index - b.index);

  for (const { candidate, index } of ordered) {
    const reason = candidateSkipReason(candidate, project, durationMs);
    if (reason) {
      skippedWithIndex.push({ skipped: { candidate, reason }, index });
      continue;
    }
    if (
      project.segments.some((segment) => overlaps(candidate, segment)) ||
      accepted.some((item) => overlaps(candidate, item))
    ) {
      skippedWithIndex.push({ skipped: { candidate, reason: "overlap" }, index });
      continue;
    }
    accepted.push(candidate);
  }

  const skipped = skippedWithIndex.sort((a, b) => a.index - b.index).map(({ skipped }) => skipped);
  const segments = [
    ...project.segments,
    ...accepted.map((candidate) => ({
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      label: candidate.source,
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
  ];
  return labels
    .filter(([reason]) => counts.has(reason))
    .map(([reason, label]) => `${counts.get(reason)} ${label}`)
    .join(", ");
}
