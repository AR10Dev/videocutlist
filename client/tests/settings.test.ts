import { describe, expect, it } from "vitest";
import { defaultSettings, loadSettings } from "../src/features/settings/model";

describe("settings", () => {
  it("falls back to safe defaults for invalid persisted values", () => {
    expect(loadSettings({ filenameTemplate: 42, cutStrategy: "unknown", muted: "yes" })).toEqual(
      defaultSettings,
    );
  });

  it("keeps valid persisted preferences", () => {
    expect(
      loadSettings({
        filenameTemplate: "clip-{segment}.{ext}",
        cutStrategy: "precise_reencode",
        muted: true,
      }),
    ).toEqual({
      ...defaultSettings,
      filenameTemplate: "clip-{segment}.{ext}",
      cutStrategy: "precise_reencode",
      muted: true,
    });
  });
});
