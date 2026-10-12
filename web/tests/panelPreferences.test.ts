import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  CENTER_MIN_WIDTH,
  PANEL_DEFAULT_MEDIA_WIDTH,
  PANEL_DEFAULT_SEGMENTS_WIDTH,
  PANEL_MIN_WIDTH,
  clampPanelPreferences,
  defaultPanelPreferences,
  parsePanelPreferences,
  panelPreferencesSchema,
  serializePanelPreferences,
} from "../src/app/panelPreferences";

describe("workspace panel preferences", () => {
  it("falls back safely and round-trips valid preferences", () => {
    const defaults = defaultPanelPreferences();
    expect(parsePanelPreferences(null)).toEqual(defaults);
    expect(parsePanelPreferences("not json")).toEqual(defaults);

    const preferences = {
      ...defaults,
      mediaWidth: 280,
      segmentsWidth: 340,
      mediaCollapsed: true,
    };
    expect(parsePanelPreferences(serializePanelPreferences(preferences))).toEqual(preferences);
  });

  it("defaults invalid fields independently and strips unknown stored properties", () => {
    expect(
      parsePanelPreferences(
        JSON.stringify({
          mediaWidth: Number.POSITIVE_INFINITY,
          segmentsWidth: 315,
          mediaCollapsed: "true",
          segmentsCollapsed: true,
          secret: "not a preference",
        }),
      ),
    ).toEqual({
      ...defaultPanelPreferences(),
      segmentsWidth: 315,
      segmentsCollapsed: true,
    });
  });

  it("decodes the complete persisted Effect schema and rejects malformed records", () => {
    const preferences = { ...defaultPanelPreferences(), mediaWidth: 280, segmentsWidth: 340 };
    expect(Schema.decodeUnknownSync(panelPreferencesSchema)(preferences)).toEqual(preferences);
    expect(() =>
      Schema.decodeUnknownSync(panelPreferencesSchema)({ ...preferences, mediaWidth: "wide" }),
    ).toThrow();
  });

  it("clamps restored widths while preserving the center minimum", () => {
    const clamped = clampPanelPreferences(
      {
        ...defaultPanelPreferences(),
        mediaWidth: 999,
        segmentsWidth: 999,
      },
      1050,
    );
    expect(clamped.mediaWidth).toBeGreaterThanOrEqual(PANEL_MIN_WIDTH);
    expect(clamped.segmentsWidth).toBeGreaterThanOrEqual(PANEL_MIN_WIDTH);
    expect(clamped.mediaWidth + clamped.segmentsWidth + CENTER_MIN_WIDTH).toBeLessThanOrEqual(
      1050 - 48,
    );
  });

  it("keeps the desktop defaults inside the configured bounds", () => {
    const defaults = defaultPanelPreferences();
    expect(defaults.mediaWidth).toBe(PANEL_DEFAULT_MEDIA_WIDTH);
    expect(defaults.segmentsWidth).toBe(PANEL_DEFAULT_SEGMENTS_WIDTH);
    expect(defaults.mediaWidth).toBeGreaterThanOrEqual(PANEL_MIN_WIDTH);
    expect(defaults.segmentsWidth).toBeGreaterThanOrEqual(PANEL_MIN_WIDTH);
    const desktop = clampPanelPreferences(defaults, 1050);
    expect(desktop).toEqual(defaults);
    expect(defaults.mediaWidth + defaults.segmentsWidth + CENTER_MIN_WIDTH).toBeLessThanOrEqual(
      1050 - 48,
    );
  });
});
