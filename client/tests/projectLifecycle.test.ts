import { describe, expect, it, vi } from "vitest";
import { confirmDiscard, newProjectId, recentProjects } from "../src/features/projects/lifecycle";

describe("project lifecycle helpers", () => {
  it("generates server-compatible project IDs", () => {
    expect(newProjectId()).toMatch(/^p_[A-Za-z0-9_-]{12,64}$/);
  });

  it("ignores corrupt recent-project storage", () => {
    expect(recentProjects("bad")).toEqual([]);
    expect(recentProjects([{ id: "p_bad", label: "x", lastOpened: 1 }])).toEqual([]);
  });

  it("keeps the existing UTF-16 label bound when reading recent-project storage", () => {
    const boundary = { id: `p_${"a".repeat(12)}`, label: "🎬".repeat(60), lastOpened: 1 };
    const tooLong = { id: `p_${"b".repeat(12)}`, label: "🎬".repeat(61), lastOpened: 2 };
    expect(recentProjects([boundary, tooLong])).toEqual([boundary]);
  });

  it("only confirms dirty changes", () => {
    const confirm = vi.fn(() => false);
    expect(confirmDiscard(false, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(confirmDiscard(true, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });
});
