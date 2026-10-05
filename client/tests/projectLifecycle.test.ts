import { describe, expect, it, vi } from "vitest";
import {
  confirmDiscard,
  newProjectId,
  parseProjectJson,
  parseProjectRecovery,
  projectJson,
  recentProjects,
} from "../src/features/projects/lifecycle";

describe("project lifecycle helpers", () => {
  it("generates server-compatible project IDs", () => {
    expect(newProjectId()).toMatch(/^p_[A-Za-z0-9_-]{12,64}$/);
  });

  it("ignores corrupt recent-project storage", () => {
    expect(recentProjects("bad")).toEqual([]);
    expect(recentProjects([{ id: "p_bad", label: "x", lastOpened: 1 }])).toEqual([]);
  });

  it("filters invalid and duplicate recent projects and strips unknown fields", () => {
    const project = { id: `p_${"a".repeat(12)}`, label: "Project", lastOpened: 1 };
    expect(
      recentProjects([
        { ...project, secret: "not persisted" },
        project,
        { ...project, id: "p_invalid" },
      ]),
    ).toEqual([project]);
  });

  it("keeps the existing UTF-16 label bound when reading recent-project storage", () => {
    const boundary = { id: `p_${"a".repeat(12)}`, label: "🎬".repeat(60), lastOpened: 1 };
    const tooLong = { id: `p_${"b".repeat(12)}`, label: "🎬".repeat(61), lastOpened: 2 };
    expect(recentProjects([boundary, tooLong])).toEqual([boundary]);
  });

  it("keeps legacy interchange fields and accepts its historical loose shape", () => {
    const legacy = {
      mediaId: "legacy-media-id",
      segments: [null, { startMs: 10, endMs: 5 }],
      uiState: { zoom: 0, oldPreference: true },
      customField: "kept",
    };
    expect(parseProjectJson(JSON.stringify(legacy))).toEqual(legacy);
  });

  it("validates recovery metadata and its embedded v2 project without stripping fields", () => {
    const recovery = {
      version: 1,
      projectId: `p_${"a".repeat(12)}`,
      revision: 0,
      schemaVersion: 2,
      name: "Recovered project",
      items: [
        {
          id: `i_${"b".repeat(12)}`,
          mediaId: `m_${"c".repeat(43)}`,
          segments: [],
          exportOptions: {},
          historicalItemField: true,
        },
      ],
      savedAt: 1,
      historicalRootField: "kept",
    };
    expect(parseProjectRecovery(recovery)).toEqual(recovery);
    expect(parseProjectRecovery({ ...recovery, revision: -1 })).toBeUndefined();
    expect(parseProjectRecovery({ ...recovery, items: [] })).toBeUndefined();
  });

  it("preserves the 1,000,000 UTF-16 code-unit JSON limit, not a UTF-8 byte limit", () => {
    const project = {
      mediaId: "legacy-media-id",
      segments: [],
      uiState: {},
      label: "🎬".repeat(262_145),
    };
    const text = JSON.stringify(project);
    expect(text.length).toBeLessThan(1_000_000);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(1 << 20);
    expect(projectJson(project)).toBe(text);
    expect(parseProjectJson(text)).toEqual(project);

    const boundary = {
      ...project,
      label: "x".repeat(1_000_000 - JSON.stringify({ ...project, label: "" }).length),
    };
    expect(projectJson(boundary).length).toBe(1_000_000);
    expect(parseProjectJson(JSON.stringify(boundary))).toEqual(boundary);
    const oversized = { ...boundary, label: boundary.label + "x" };
    expect(() => projectJson(oversized)).toThrow("too large");
    expect(() => parseProjectJson(JSON.stringify(oversized))).toThrow("too large");
  });

  it("applies recovery size validation only to its embedded document", () => {
    const recovery = {
      version: 1,
      projectId: `p_${"a".repeat(12)}`,
      revision: 0,
      schemaVersion: 2,
      name: "Recovered Unicode",
      items: [
        {
          id: `i_${"b".repeat(12)}`,
          mediaId: `m_${"c".repeat(43)}`,
          segments: [],
          exportOptions: {},
          historicalItemField: "🎬".repeat(262_145),
        },
      ],
      savedAt: 1,
      historicalRootField: "x".repeat(1_000_000),
    };
    expect(JSON.stringify(recovery).length).toBeGreaterThan(1_000_000);
    expect(parseProjectRecovery(recovery)).toEqual(recovery);
    expect(parseProjectRecovery({ ...recovery, name: "x".repeat(1_000_000) })).toBeUndefined();
  });

  it("only confirms dirty changes", () => {
    const confirm = vi.fn(() => false);
    expect(confirmDiscard(false, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(confirmDiscard(true, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });
});
