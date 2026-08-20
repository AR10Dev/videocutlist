import { describe, expect, it } from "vitest";
import { acceptCandidate } from "../src/detection";
import { confirmDiscard, recentProjects } from "../src/projectLifecycle";

describe("Solid persistence and jobs contracts", () => {
  it("accepts only candidates matching the saved project revision", () => {
    const project = {
      id: "p_12345678-1234-4234-8234-123456789012",
      mediaId: "m_1234567890123456789012345678901234567890123",
      revision: 2,
      segments: [],
    };
    const candidate = {
      id: "c1",
      mediaId: project.mediaId,
      projectId: project.id,
      projectRevision: 2,
      startMs: 100,
      endMs: 200,
      source: "silence" as const,
      confidence: 0.9,
    };
    expect(acceptCandidate(candidate, project, 1000)?.segments).toHaveLength(1);
    expect(
      acceptCandidate({ ...candidate, projectRevision: 1 }, project, 1000),
    ).toBeNull();
  });

  it("keeps recent projects bounded and confirms clean/discard behavior", () => {
    const id = "p_12345678-1234-4234-8234-123456789012";
    expect(recentProjects([{ id, label: "Demo", lastOpened: 1 }])).toHaveLength(
      1,
    );
    expect(confirmDiscard(false, () => false)).toBe(true);
    expect(confirmDiscard(true, () => false)).toBe(false);
  });
});
