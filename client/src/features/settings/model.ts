export type Appearance = "system" | "dark" | "light";

export type AppSettings = {
  filenameTemplate: string;
  cutStrategy: "stream_copy_preferred" | "precise_reencode" | "hybrid_smart_cut";
  muted: boolean;
  appearance: Appearance;
};

export const settingsKey = "videocutlist.settings.v1";
export const defaultSettings: AppSettings = {
  filenameTemplate: "{source}-{segment}.{ext}",
  cutStrategy: "stream_copy_preferred",
  muted: false,
  appearance: "system",
};

const appearances = new Set<Appearance>(["system", "dark", "light"]);

export function resolveAppearance(appearance: Appearance, prefersDark: boolean): "dark" | "light" {
  return appearance === "system" ? (prefersDark ? "dark" : "light") : appearance;
}

export function applyAppearance(appearance: Appearance, prefersDark = false): void {
  const theme = resolveAppearance(appearance, prefersDark);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

const strategies = new Set<AppSettings["cutStrategy"]>([
  "stream_copy_preferred",
  "precise_reencode",
  "hybrid_smart_cut",
]);

export function loadSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") return defaultSettings;
  const settings = value as Partial<AppSettings>;
  return {
    filenameTemplate:
      typeof settings.filenameTemplate === "string" && settings.filenameTemplate.length <= 240
        ? settings.filenameTemplate
        : defaultSettings.filenameTemplate,
    cutStrategy: strategies.has(settings.cutStrategy ?? defaultSettings.cutStrategy)
      ? (settings.cutStrategy ?? defaultSettings.cutStrategy)
      : defaultSettings.cutStrategy,
    muted: typeof settings.muted === "boolean" ? settings.muted : defaultSettings.muted,
    appearance: appearances.has(settings.appearance ?? defaultSettings.appearance)
      ? (settings.appearance ?? defaultSettings.appearance)
      : defaultSettings.appearance,
  };
}

export function storedSettings(storage: Storage): AppSettings {
  try {
    return loadSettings(JSON.parse(storage.getItem(settingsKey) ?? "null"));
  } catch {
    return defaultSettings;
  }
}
