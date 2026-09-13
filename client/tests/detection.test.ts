import { describe, expect, it } from "vitest";
import { editTimeline, createTimelineHistory, undoTimeline } from "../src/features/editor/timeline";
import {
  acceptCandidate,
  acceptCandidates,
  candidatePointMs,
  candidateSkipReason,
  skippedCandidateSummary,
  type Candidate,
} from "../src/features/detection/model";

const candidate = {
  id: "c_1",
  mediaId: "m_1",
  projectId: "p_1",
  projectRevision: 2,
  startMs: 10,
  endMs: 20,
  source: "silence" as const,
};
const point = {
  id: "c_point",
  mediaId: "m_1",
  projectId: "p_1",
  projectRevision: 2,
  pointMs: 50,
  source: "scene" as const,
};
const project = { id: "p_1", mediaId: "m_1", revision: 2, segments: [] };
describe("candidate acceptance", () => {
  it("adds only a current, non-overlapping range candidate", () =>
    expect(acceptCandidate(candidate, project, 100)?.segments).toEqual([
      { startMs: 10, endMs: 20, label: "silence", included: true },
    ]));

  it("reports stale, invalid, overlapping, and point candidates", () => {
    const result = acceptCandidates(
      [
        candidate,
        { ...candidate, id: "c_overlap", startMs: 15, endMs: 25 },
        { ...candidate, id: "c_stale", projectRevision: 1 },
        { ...candidate, id: "c_invalid", startMs: 90, endMs: 110 },
        point,
      ],
      project,
      100,
    );
    expect(result.accepted.map((item) => item.id)).toEqual(["c_1"]);
    expect(result.skipped.map((item) => [item.candidate.id, item.reason])).toEqual([
      ["c_overlap", "overlap"],
      ["c_stale", "stale"],
      ["c_invalid", "invalid"],
      ["c_point", "point"],
    ]);
    expect(skippedCandidateSummary(result.skipped)).toBe(
      "1 stale, 1 invalid, 1 overlapping, 1 scene points",
    );
    expect(candidateSkipReason({ ...candidate, endMs: 101 }, project, 100)).toBe("invalid");
  });

  it("keeps scene points review-only and supports legacy one-millisecond results", () => {
    expect(acceptCandidate(point, project, 100)).toBeNull();
    const legacy = {
      ...point,
      pointMs: undefined,
      startMs: 50,
      endMs: 51,
    } as unknown as Candidate;
    expect(candidatePointMs(legacy)).toBe(50);
    expect(candidateSkipReason(legacy, project, 100)).toBe("point");
  });

  it("publishes a bulk result as one undoable timeline edit", () => {
    const result = acceptCandidates(
      [candidate, { ...candidate, id: "c_2", startMs: 30, endMs: 40 }],
      project,
      100,
    );
    const history = editTimeline(
      createTimelineHistory({ playheadMs: 0, segments: project.segments, zoom: 1 }),
      { segments: result.segments },
    );
    expect(history.past).toHaveLength(1);
    expect(undoTimeline(history).present.segments).toEqual([]);
  });

  it("rejects stale and overlapping candidates without mutation", () => {
    expect(acceptCandidate({ ...candidate, projectRevision: 1 }, project, 100)).toBeNull();
    expect(
      acceptCandidate(
        { ...candidate, startMs: 15 },
        { ...project, segments: [{ startMs: 12, endMs: 18, included: true }] },
        100,
      ),
    ).toBeNull();
  });
});
