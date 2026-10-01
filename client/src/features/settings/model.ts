import * as Schema from "effect/Schema";
import type { components } from "../../generated/api";

type RuntimeSettings = components["schemas"]["RuntimeSettings"];
type RuntimeSettingsInput = components["schemas"]["SettingsUpdate"]["settings"];

const positiveLimit = Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0));
const runtimeSettingsInput = Schema.Struct({
  exportLimit: positiveLimit.check(Schema.isLessThanOrEqualTo(64)),
  cacheMaxBytes: positiveLimit,
  previewGlobalLimit: positiveLimit.check(Schema.isLessThanOrEqualTo(64)),
  previewBeforeMs: positiveLimit,
  previewAfterMs: positiveLimit,
  previewMaxMs: positiveLimit,
  previewGridMs: positiveLimit,
  mediaMaxFiles: positiveLimit,
  mediaMaxDepth: positiveLimit,
  mcpEnabled: Schema.Boolean,
});

export function validRuntimeSettingsInput(
  value: Partial<RuntimeSettings>,
): value is RuntimeSettingsInput {
  try {
    const settings = Schema.decodeUnknownSync(runtimeSettingsInput)(value);
    return settings.previewBeforeMs + settings.previewAfterMs <= settings.previewMaxMs;
  } catch {
    return false;
  }
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

const filenameTemplateSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    validFilenameTemplateLength(value) ? undefined : "UTF-8 filename template is too long",
  ),
);
const cutStrategySchema = Schema.Literals([
  "stream_copy_preferred",
  "precise_reencode",
  "hybrid_smart_cut",
]);
const appearanceSchema = Schema.Literals(appearances);

function decodeOrDefault<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  fallback: S["Type"],
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    return fallback;
  }
}

export function loadSettings(value: unknown): AppSettings {
  const settings = value && typeof value === "object" ? value : {};
  const field = (key: string) =>
    Object.hasOwn(settings, key) ? Reflect.get(settings, key) : undefined;
  return {
    filenameTemplate: decodeOrDefault(
      filenameTemplateSchema,
      field("filenameTemplate"),
      defaultSettings.filenameTemplate,
    ),
    cutStrategy: decodeOrDefault(
      cutStrategySchema,
      field("cutStrategy"),
      defaultSettings.cutStrategy,
    ),
    muted: decodeOrDefault(Schema.Boolean, field("muted"), defaultSettings.muted),
    appearance: decodeOrDefault(appearanceSchema, field("appearance"), defaultSettings.appearance),
  };
}

export function storedSettings(): AppSettings {
  try {
    return loadSettings(JSON.parse(globalThis.localStorage?.getItem(settingsKey) ?? "null"));
  } catch {
    return defaultSettings;
  }
}
