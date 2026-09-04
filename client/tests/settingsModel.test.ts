import { describe, expect, it } from "vitest";
import { defaultSettings, loadSettings } from "../src/features/settings/model";

describe("appearance settings", () => {
  it("preserves valid appearance values and unrelated preferences", () => {
    const settings = loadSettings({ ...defaultSettings, appearance: "light", muted: true });
    expect(settings.appearance).toBe("light");
    expect(settings.muted).toBe(true);
  });

  it("normalizes invalid appearance values to system", () => {
    expect(loadSettings({ ...defaultSettings, appearance: "sepia" }).appearance).toBe("system");
    expect(loadSettings({ ...defaultSettings, appearance: null }).appearance).toBe("system");
  });
});
