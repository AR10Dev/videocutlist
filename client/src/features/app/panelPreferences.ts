export const PANEL_PREFERENCES_KEY = "videocutlist.workspace-panels.v1";

export const PANEL_MIN_WIDTH = 200;
export const PANEL_MAX_MEDIA_WIDTH = 360;
export const PANEL_MAX_SEGMENTS_WIDTH = 420;
export const PANEL_DEFAULT_MEDIA_WIDTH = 240;
export const PANEL_DEFAULT_SEGMENTS_WIDTH = 300;
export const CENTER_MIN_WIDTH = 400;
export const WORKSPACE_EDGE_SPACE = 48;

export type PanelPreferences = {
  mediaWidth: number;
  segmentsWidth: number;
  mediaCollapsed: boolean;
  segmentsCollapsed: boolean;
};

export const defaultPanelPreferences = (): PanelPreferences => ({
  mediaWidth: PANEL_DEFAULT_MEDIA_WIDTH,
  segmentsWidth: PANEL_DEFAULT_SEGMENTS_WIDTH,
  mediaCollapsed: false,
  segmentsCollapsed: false,
});

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export function parsePanelPreferences(value: string | null): PanelPreferences {
  const defaults = defaultPanelPreferences();
  if (!value) return defaults;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      mediaWidth: numberOr(parsed.mediaWidth, defaults.mediaWidth),
      segmentsWidth: numberOr(parsed.segmentsWidth, defaults.segmentsWidth),
      mediaCollapsed:
        typeof parsed.mediaCollapsed === "boolean"
          ? parsed.mediaCollapsed
          : defaults.mediaCollapsed,
      segmentsCollapsed:
        typeof parsed.segmentsCollapsed === "boolean"
          ? parsed.segmentsCollapsed
          : defaults.segmentsCollapsed,
    };
  } catch {
    return defaults;
  }
}

export function clampPanelPreferences(
  preferences: PanelPreferences,
  viewportWidth: number,
): PanelPreferences {
  const available = Math.max(0, viewportWidth - WORKSPACE_EDGE_SPACE);
  const mediaMaximum = Math.min(
    PANEL_MAX_MEDIA_WIDTH,
    Math.max(PANEL_MIN_WIDTH, available - CENTER_MIN_WIDTH - PANEL_MIN_WIDTH),
  );
  const mediaWidth = Math.min(
    mediaMaximum,
    Math.max(PANEL_MIN_WIDTH, Math.round(preferences.mediaWidth)),
  );
  const segmentsMaximum = Math.min(
    PANEL_MAX_SEGMENTS_WIDTH,
    Math.max(PANEL_MIN_WIDTH, available - CENTER_MIN_WIDTH - mediaWidth),
  );
  const segmentsWidth = Math.min(
    segmentsMaximum,
    Math.max(PANEL_MIN_WIDTH, Math.round(preferences.segmentsWidth)),
  );
  return { ...preferences, mediaWidth, segmentsWidth };
}

export function serializePanelPreferences(preferences: PanelPreferences): string {
  return JSON.stringify(preferences);
}
