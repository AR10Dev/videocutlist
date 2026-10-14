import { describe, expect, it, vi } from "vitest";
import * as Schema from "effect/Schema";
import {
  confirmDiscard,
  newProjectId,
  recentProjectsSchema,
  recoverySchema,
} from "../src/features/projects/lifecycle";

describe("project lifecycle helpers", () => {
  it("generates server-compatible project IDs", () => {
    expect(newProjectId()).toMatch(/^p_[A-Za-z0-9_-]{12,64}$/);
  });

  it("rejects corrupt, duplicate and oversized recent-project storage", () => {
    const project = { id: `p_${"a".repeat(12)}`, label: "Project", lastOpened: 1 };
    for (const invalid of [
      "bad",
      [{ ...project, id: "p_bad" }],
      [project, project],
      Array.from({ length: 21 }, (_, index) => ({
        ...project,
        id: `p_${String(index).padStart(12, "0")}`,
      })),
    ]) {
      expect(() => Schema.decodeUnknownSync(recentProjectsSchema)(invalid)).toThrow();
    }
    expect(
      Schema.decodeUnknownSync(recentProjectsSchema)([{ ...project, secret: "not persisted" }]),
    ).toEqual([project]);
  });

  it("uses the project-name code-point limit for recent labels in decoding and encoding", () => {
    const boundary = { id: `p_${"a".repeat(12)}`, label: "🎬".repeat(120), lastOpened: 1 };
    const tooLong = { ...boundary, label: "🎬".repeat(121) };
    const blank = { ...boundary, label: " \t\n " };
    expect(Schema.decodeUnknownSync(recentProjectsSchema)([boundary])).toEqual([boundary]);
    expect(Schema.encodeSync(recentProjectsSchema)([boundary])).toEqual([boundary]);
    for (const invalid of [tooLong, blank]) {
      expect(() => Schema.decodeUnknownSync(recentProjectsSchema)([invalid])).toThrow();
      expect(() => Schema.encodeSync(recentProjectsSchema)([invalid])).toThrow();
    }
  });

  it("keeps recovery decoding local and does not treat legacy project files as recovery", () => {
    expect(() =>
      Schema.decodeUnknownSync(recoverySchema)({
        mediaId: `m_${"a".repeat(43)}`,
        segments: [],
        uiState: {},
      }),
    ).toThrow();
  });

  it("validates recovery metadata and strips unknown fields", () => {
    const recovery = {
      version: 1,
      projectId: `p_${"a".repeat(12)}`,
      revision: 0,
      schemaVersion: 2,
      name: "Recovered project",
      items: [
        {
          id: `i_${"b".repeat(24)}`,
          mediaId: `m_${"c".repeat(43)}`,
          segments: [],
          exportOptions: {},
        },
      ],
      savedAt: 1,
    };
    expect(Schema.decodeUnknownSync(recoverySchema)(recovery)).toEqual(recovery);
    expect(
      Schema.decodeUnknownSync(recoverySchema)({ ...recovery, historicalRootField: "kept" }),
    ).toEqual(recovery);
    expect(Schema.decodeUnknownSync(recoverySchema)(null)).toBeNull();
    expect(() => Schema.decodeUnknownSync(recoverySchema)({ ...recovery, revision: -1 })).toThrow();
    expect(() => Schema.decodeUnknownSync(recoverySchema)({ ...recovery, items: [] })).toThrow();
  });

  it("bounds local recovery by UTF-16 JSON length rather than UTF-8 bytes", () => {
    const recovery = {
      version: 1 as const,
      projectId: `p_${"a".repeat(12)}`,
      revision: 0,
      schemaVersion: 2 as const,
      name: "Recovered",
      items: [
        {
          id: `i_${"b".repeat(24)}`,
          mediaId: `m_${"c".repeat(43)}`,
          segments: Array.from({ length: 1300 }, (_, index) => ({
            startMs: index * 2,
            endMs: index * 2 + 1,
            label: "🎬".repeat(200),
          })),
          exportOptions: {},
        },
      ],
      savedAt: 1,
    };
    const text = JSON.stringify({
      schemaVersion: 2,
      name: recovery.name,
      items: recovery.items,
    });
    expect(text.length).toBeLessThan(1_000_000);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(1 << 20);
    expect(Schema.decodeUnknownSync(recoverySchema)(recovery)).toEqual(recovery);

    const oversized = {
      ...recovery,
      items: [
        {
          ...recovery.items[0],
          segments: Array.from({ length: 2500 }, (_, index) => ({
            startMs: index * 2,
            endMs: index * 2 + 1,
            label: "🎬".repeat(200),
          })),
        },
      ],
    };
    expect(
      JSON.stringify({ schemaVersion: 2, name: oversized.name, items: oversized.items }).length,
    ).toBeGreaterThan(1_000_000);
    expect(() => Schema.decodeUnknownSync(recoverySchema)(oversized)).toThrow();
  });

  it("strips unknown recovery fields and validates the remaining document size", () => {
    const recovery = {
      version: 1,
      projectId: `p_${"a".repeat(12)}`,
      revision: 0,
      schemaVersion: 2,
      name: "Recovered Unicode",
      items: [
        {
          id: `i_${"b".repeat(24)}`,
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
    expect(Schema.decodeUnknownSync(recoverySchema)(recovery)).toEqual({
      version: 1,
      projectId: recovery.projectId,
      revision: 0,
      schemaVersion: 2,
      name: recovery.name,
      savedAt: 1,
      items: [
        {
          id: recovery.items[0].id,
          mediaId: recovery.items[0].mediaId,
          segments: [],
          exportOptions: {},
        },
      ],
    });
    expect(() =>
      Schema.decodeUnknownSync(recoverySchema)({ ...recovery, name: "x".repeat(1_000_000) }),
    ).toThrow();
  });

  it("only confirms dirty changes", () => {
    const confirm = vi.fn(() => false);
    expect(confirmDiscard(false, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(confirmDiscard(true, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });
});
