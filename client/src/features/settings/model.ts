import { z } from "zod";
import type { components } from "../../generated/api";

type RuntimeSettings = components["schemas"]["RuntimeSettings"];
type RuntimeSettingsInput = components["schemas"]["SettingsUpdate"]["settings"];

const positiveLimit = z.number().int().positive();
const runtimeSettingsInput = z
  .object({
    exportLimit: positiveLimit.max(64),
    cacheMaxBytes: positiveLimit,
    previewGlobalLimit: positiveLimit.max(64),
    previewBeforeMs: positiveLimit,
    previewAfterMs: positiveLimit,
    previewMaxMs: positiveLimit,
    previewGridMs: positiveLimit,
    mediaMaxFiles: positiveLimit,
    mediaMaxDepth: positiveLimit,
    mcpEnabled: z.boolean(),
  })
  .refine((value) => value.previewBeforeMs + value.previewAfterMs <= value.previewMaxMs);

export function validRuntimeSettingsInput(
  value: Partial<RuntimeSettings>,
): value is RuntimeSettingsInput {
  return runtimeSettingsInput.validate(value);
}

export const appearances = [
  "system",
  "light",
  "dark",
  "cupcake",
  "bumblebee",
  "emerald",
  "corporate",
  "synthwave",
  "retro",
  "cyberpunk",
  "valentine",
  "halloween",
  "garden",
  "forest",
  "aqua",
  "lofi",
  "pastel",
  "fantasy",
  "wireframe",
  "black",
  "luxury",
  "dracula",
  "cmyk",
  "autumn",
  "business",
  "acid",
  "lemonade",
  "night",
  "coffee",
  "winter",
  "dim",
  "nord",
  "sunset",
  "caramellatte",
  "abyss",
  "silk",
] as const;

export type Appearance = (typeof appearances)[number];

export type AppSettings = {
  filenameTemplate: string;
  cutStrategy: "stream_copy_preferred" | "precise_reencode" | "hybrid_smart_cut";
  muted: boolean;
  appearance: Appearance;
};

export const settingsKey = "videocutlist.settings.v1";
export const maxFilenameTemplateLength = 160;
// Go validates filename templates as UTF-8 bytes, not UTF-16 code units.
export const validFilenameTemplateLength = (template: string) =>
  new TextEncoder().encode(template).length <= maxFilenameTemplateLength;
export const defaultSettings: AppSettings = {
  filenameTemplate: "{source}-{segment}.{ext}",
  cutStrategy: "stream_copy_preferred",
  muted: false,
  appearance: "system",
};

export function resolveAppearance(appearance: Appearance, prefersDark: boolean): Appearance {
  return appearance === "system" ? (prefersDark ? "dark" : "light") : appearance;
}

export function applyAppearance(appearance: Appearance, prefersDark = false): void {
  document.documentElement.dataset.theme = resolveAppearance(appearance, prefersDark);
}

const browserSettings = z.object({
  filenameTemplate: z
    .string()
    .refine(validFilenameTemplateLength)
    .catch(defaultSettings.filenameTemplate),
  cutStrategy: z
    .enum(["stream_copy_preferred", "precise_reencode", "hybrid_smart_cut"])
    .catch(defaultSettings.cutStrategy),
  muted: z.boolean().catch(defaultSettings.muted),
  appearance: z.enum(appearances).catch(defaultSettings.appearance),
});

export function loadSettings(value: unknown): AppSettings {
  const parsed = browserSettings.safeParse(value);
  return parsed.success ? parsed.data : defaultSettings;
}

export function storedSettings(): AppSettings {
  try {
    return loadSettings(JSON.parse(globalThis.localStorage?.getItem(settingsKey) ?? "null"));
  } catch {
    return defaultSettings;
  }
}
