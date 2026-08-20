import { describe, expect, it, vi } from "vitest";
import { confirmDiscard, newProjectId, recentProjects } from "../src/projectLifecycle";

describe("project lifecycle helpers", () => {
  it("generates server-compatible project IDs", () => {
    expect(newProjectId()).toMatch(/^p_[A-Za-z0-9_-]{12,64}$/);
  });

  it("ignores corrupt recent-project storage", () => {
    expect(recentProjects("bad")).toEqual([]);
    expect(recentProjects([{ id: "p_bad", label: "x", lastOpened: 1 }])).toEqual([]);
  });

  it("only confirms dirty changes", () => {
    const confirm = vi.fn(() => false);
    expect(confirmDiscard(false, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(confirmDiscard(true, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });
});
