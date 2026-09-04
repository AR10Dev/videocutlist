import { describe, expect, it } from "vitest";
import {
  appearances,
  defaultSettings,
  loadSettings,
  resolveAppearance,
} from "../src/features/settings/model";

describe("appearance settings", () => {
  it("preserves valid appearance values and unrelated preferences", () => {
    const settings = loadSettings({ ...defaultSettings, appearance: "dracula", muted: true });
    expect(settings.appearance).toBe("dracula");
    expect(settings.muted).toBe(true);
  });

  it("normalizes invalid appearance values to system without resetting other preferences", () => {
    expect(
      loadSettings({
        ...defaultSettings,
        appearance: "sepia",
        filenameTemplate: "clip-{segment}",
        muted: true,
      }),
    ).toMatchObject({ appearance: "system", filenameTemplate: "clip-{segment}", muted: true });
    expect(loadSettings({ ...defaultSettings, appearance: null }).appearance).toBe("system");
  });

  it("resolves System to the operating-system preference", () => {
    expect(resolveAppearance("system", false)).toBe("light");
    expect(resolveAppearance("system", true)).toBe("dark");
    expect(resolveAppearance("dracula", false)).toBe("dracula");
  });

  it("offers each retained theme exactly once", () => {
    expect(new Set(appearances).size).toBe(appearances.length);
    expect(appearances).toContain("system");
    expect(appearances).toContain("light");
    expect(appearances).toContain("dark");
  });
});
