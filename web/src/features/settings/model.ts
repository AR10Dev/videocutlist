import type * as EffectApiTypes from "../../generated/effect-api";
import * as Schema from "effect/Schema";
import { validDestinationId } from "../export/destination";

type RuntimeSettings = EffectApiTypes.SettingsResponse["settings"];
type RuntimeSettingsInput = EffectApiTypes.SettingsUpdate["settings"];
type MediaRootStatus = Pick<
  EffectApiTypes.SettingsResponse["roots"][string],
  "state" | "message" | "reasonCode"
>;

export function mediaRootStatusPresentation(root: MediaRootStatus): {
  status: string;
  guidance?: string;
} {
  if (root.reasonCode === "media_root_available") return { status: "Available" };
  if (root.reasonCode === "media_root_unavailable")
    return {
      status: "Unavailable",
      guidance:
        "Check that the media mount is present and that the server has permission to access the configured directory.",
    };
  return {
    status:
      root.state === "unavailable"
        ? "Unavailable"
        : root.state === "ready"
          ? "Available"
          : "Status unavailable",
  };
}

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

export type BrowserPreferences = AppSettings & {
  waveformVisible: boolean;
  loopSelectedSegment: boolean;
  lastDestinationId?: string;
};

export const browserPreferencesKey = "videocutlist.browser-preferences.v1";
export const legacySettingsKey = "videocutlist.settings.v1";
export const legacyWaveformVisibleKey = "videocutlist.waveform-visible.v1";
export const legacyLoopSelectedSegmentKey = "videocutlist.loop-selected-segment.v1";
export const legacyDestinationKey = "videocutlist.last-destination.v1";
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
export const defaultBrowserPreferences: BrowserPreferences = {
  ...defaultSettings,
  waveformVisible: true,
  loopSelectedSegment: false,
};

export function resolveAppearance(appearance: Appearance, prefersDark: boolean): Appearance {
  return appearance === "system" ? (prefersDark ? "dark" : "light") : appearance;
}

export function applyAppearance(appearance: Appearance, prefersDark = false): void {
  document.documentElement.dataset.theme = resolveAppearance(appearance, prefersDark);
}

export const filenameTemplateSchema = Schema.String.check(
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
const destinationIdSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    validDestinationId(value) ? undefined : "Invalid destination identifier",
  ),
);

export const browserPreferencesSchema = Schema.Struct({
  filenameTemplate: filenameTemplateSchema,
  cutStrategy: cutStrategySchema,
  muted: Schema.Boolean,
  appearance: appearanceSchema,
  waveformVisible: Schema.Boolean,
  loopSelectedSegment: Schema.Boolean,
  lastDestinationId: Schema.optionalKey(destinationIdSchema),
});

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

function legacySettings(value: unknown): AppSettings {
  const settings = value !== null && typeof value === "object" ? value : {};
  const field = (key: string): unknown => Object.getOwnPropertyDescriptor(settings, key)?.value;
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

/** Decodes the former independent preference keys only when the consolidated value is absent. */
export function decodeLegacyBrowserPreferences(
  settingsRaw: string | undefined,
  waveformRaw: string | undefined,
  loopRaw: string | undefined,
  destinationRaw: string | undefined,
): BrowserPreferences | undefined {
  if (
    settingsRaw === undefined &&
    waveformRaw === undefined &&
    loopRaw === undefined &&
    destinationRaw === undefined
  )
    return undefined;

  let settingsValue: unknown;
  try {
    settingsValue = settingsRaw === undefined ? undefined : JSON.parse(settingsRaw);
  } catch {
    settingsValue = undefined;
  }
  const settings = legacySettings(settingsValue);
  const destination = validDestinationId(destinationRaw) ? destinationRaw : undefined;
  return {
    ...settings,
    waveformVisible: waveformRaw !== "false",
    loopSelectedSegment: loopRaw === "true",
    ...(destination !== undefined ? { lastDestinationId: destination } : {}),
  };
}
