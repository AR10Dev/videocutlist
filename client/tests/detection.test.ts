import { describe, expect, it } from "vitest";
import { acceptCandidate } from "../src/detection";
const candidate = { id: "c_1", mediaId: "m_1", projectId: "p_1", projectRevision: 2, startMs: 10, endMs: 20, source: "silence" as const, confidence: .9 };
const project = { id: "p_1", mediaId: "m_1", revision: 2, segments: [] };
describe("candidate acceptance", () => {
 it("adds only a current, non-overlapping candidate", () => expect(acceptCandidate(candidate, project, 100)?.segments).toEqual([{ startMs: 10, endMs: 20, label: "silence" }]));
 it("rejects stale and overlapping candidates without mutation", () => {
  expect(acceptCandidate({ ...candidate, projectRevision: 1 }, project, 100)).toBeNull();
  expect(acceptCandidate({ ...candidate, startMs: 15 }, { ...project, segments: [{ startMs: 12, endMs: 18 }] }, 100)).toBeNull();
 });
});
