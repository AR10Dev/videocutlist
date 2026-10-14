import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  appearances,
  browserPreferencesSchema,
  defaultBrowserPreferences,
  mediaRootStatusPresentation,
  resolveAppearance,
  validFilenameTemplateLength,
} from "../src/features/settings/model";

describe("browser preference schemas", () => {
  const decode = Schema.decodeUnknownSync(browserPreferencesSchema);

  it("restores valid appearance and preview preferences", () => {
    expect(
      decode({
        ...defaultBrowserPreferences,
        appearance: "dracula",
        filenameTemplate: "clip-{segment}.{ext}",
        cutStrategy: "precise_reencode",
        muted: true,
        waveformVisible: false,
        loopSelectedSegment: true,
        lastDestinationId: "archive",
      }),
    ).toEqual({
      ...defaultBrowserPreferences,
      appearance: "dracula",
      filenameTemplate: "clip-{segment}.{ext}",
      cutStrategy: "precise_reencode",
      muted: true,
      waveformVisible: false,
      loopSelectedSegment: true,
      lastDestinationId: "archive",
    });
  });

  it("enforces the filename template UTF-8 byte limit", () => {
    expect(validFilenameTemplateLength("x".repeat(160))).toBe(true);
    expect(validFilenameTemplateLength("x".repeat(161))).toBe(false);
    expect(validFilenameTemplateLength("é".repeat(80))).toBe(true);
    expect(validFilenameTemplateLength("é".repeat(81))).toBe(false);
    expect(
      decode({ ...defaultBrowserPreferences, filenameTemplate: "é".repeat(80) }).filenameTemplate,
    ).toBe("é".repeat(80));
    expect(() =>
      decode({ ...defaultBrowserPreferences, filenameTemplate: "é".repeat(81) }),
    ).toThrow();
  });

  it.each([
    { filenameTemplate: 42 },
    { cutStrategy: "unknown" },
    { muted: "yes" },
    { appearance: "sepia" },
    { lastDestinationId: "../private" },
  ])("rejects invalid persisted preference %j", (invalid) => {
    expect(() => decode({ ...defaultBrowserPreferences, ...invalid })).toThrow();
  });
});

describe("media root status presentation", () => {
  it("uses frontend wording for known reasons instead of the server message", () => {
    expect(
      mediaRootStatusPresentation({
        state: "ready",
        reasonCode: "media_root_available",
        message: "/private/deployment/root",
      }),
    ).toEqual({ status: "Available" });
    expect(
      mediaRootStatusPresentation({
        state: "unavailable",
        reasonCode: "media_root_unavailable",
        message: "/private/deployment/root: permission denied",
      }),
    ).toEqual({
      status: "Unavailable",
      guidance:
        "Check that the media mount is present and that the server has permission to access the configured directory.",
    });
  });

  it.each([
    {
      root: {
        state: "unavailable" as const,
        reasonCode: "future_reason",
        message: "/private/root",
      },
      status: "Unavailable",
    },
    { root: { state: "unavailable" as const, message: "/private/root" }, status: "Unavailable" },
    {
      root: { state: "ready" as const, reasonCode: "future_reason", message: "/private/root" },
      status: "Available",
    },
    { root: { message: "/private/root" }, status: "Status unavailable" },
  ])("safely falls back for unknown or omitted reasons: $root", ({ root, status }) => {
    const presentation = mediaRootStatusPresentation(root);
    expect(presentation).toEqual({ status });
    expect(JSON.stringify(presentation)).not.toContain("/private/root");
  });
});

describe("appearance themes", () => {
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

  it("resolves every selectable theme without falling back", () => {
    for (const appearance of appearances) {
      if (appearance === "system") continue;
      expect(resolveAppearance(appearance, false)).toBe(appearance);
      expect(resolveAppearance(appearance, true)).toBe(appearance);
    }
  });
});
