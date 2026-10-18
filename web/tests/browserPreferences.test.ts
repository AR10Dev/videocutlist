import { Effect } from "effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api";
import { createServerState } from "../src/app/server";
import {
  browserPreferencesKey,
  defaultBrowserPreferences,
  legacyDestinationKey,
  legacyLoopSelectedSegmentKey,
  legacySettingsKey,
  legacyWaveformVisibleKey,
} from "../src/features/settings/model";
import { memoryStorage } from "./memoryStorage";

afterEach(() => vi.unstubAllGlobals());

function workspace() {
  const configuration = {
    serverBaseUrl: "https://example.test",
    authentication: { type: "none" as const },
  };
  const registry = AtomRegistry.make();
  const server = createServerState(createApiClient(configuration), registry, configuration);
  return { registry, server };
}

describe("workspace browser preferences", () => {
  it("restores before writes, saves edits, and reloads the complete preference set", async () => {
    const storage = memoryStorage();
    const restored = {
      ...defaultBrowserPreferences,
      filenameTemplate: "restored-{segment}.{ext}",
      appearance: "dracula" as const,
      muted: true,
      waveformVisible: false,
      loopSelectedSegment: true,
      lastDestinationId: "archive",
    };
    storage.setItem(browserPreferencesKey, JSON.stringify(restored));
    const setItem = vi.spyOn(storage, "setItem");
    vi.stubGlobal("localStorage", storage);

    const first = workspace();
    try {
      await Effect.runPromise(
        AtomRegistry.getResult(first.registry, first.server.preferences.initialize, {
          suspendOnWaiting: true,
        }),
      );
      expect(first.registry.get(first.server.preferences.value)).toEqual(restored);
      expect(setItem).not.toHaveBeenCalled();

      const edited = { ...restored, loopSelectedSegment: false };
      first.registry.set(first.server.preferences.value, edited);
      await Effect.runPromise(
        AtomRegistry.getResult(first.registry, first.server.preferences.save, {
          suspendOnWaiting: true,
        }),
      );
      expect(JSON.parse(storage.getItem(browserPreferencesKey) ?? "null")).toEqual(edited);
    } finally {
      first.registry.dispose();
    }

    const reloaded = workspace();
    try {
      await Effect.runPromise(
        AtomRegistry.getResult(reloaded.registry, reloaded.server.preferences.initialize, {
          suspendOnWaiting: true,
        }),
      );
      expect(reloaded.registry.get(reloaded.server.preferences.value)).toEqual({
        ...restored,
        loopSelectedSegment: false,
      });
    } finally {
      reloaded.registry.dispose();
    }
  });

  it("migrates the former independent preference keys and keeps them as fallback data", async () => {
    const storage = memoryStorage();
    const oldSettings = {
      filenameTemplate: "legacy-{source}.{ext}",
      cutStrategy: "hybrid_smart_cut",
      muted: true,
      appearance: "dracula",
    };
    storage.setItem(legacySettingsKey, JSON.stringify(oldSettings));
    storage.setItem(legacyWaveformVisibleKey, "false");
    storage.setItem(legacyLoopSelectedSegmentKey, "true");
    storage.setItem(legacyDestinationKey, "archive");
    vi.stubGlobal("localStorage", storage);

    const first = workspace();
    const expected = {
      ...oldSettings,
      waveformVisible: false,
      loopSelectedSegment: true,
      lastDestinationId: "archive",
    } as const;
    try {
      await Effect.runPromise(
        AtomRegistry.getResult(first.registry, first.server.preferences.initialize, {
          suspendOnWaiting: true,
        }),
      );
      expect(first.registry.get(first.server.preferences.value)).toEqual(expected);
      expect(JSON.parse(storage.getItem(browserPreferencesKey) ?? "null")).toEqual(expected);
      expect(storage.getItem(legacySettingsKey)).toBe(JSON.stringify(oldSettings));
    } finally {
      first.registry.dispose();
    }

    storage.setItem(legacySettingsKey, JSON.stringify({ appearance: "light" }));
    const reloaded = workspace();
    try {
      await Effect.runPromise(
        AtomRegistry.getResult(reloaded.registry, reloaded.server.preferences.initialize, {
          suspendOnWaiting: true,
        }),
      );
      expect(reloaded.registry.get(reloaded.server.preferences.value)).toEqual(expected);
    } finally {
      reloaded.registry.dispose();
    }
  });

  it("validates legacy preference fields independently and keeps safe defaults", async () => {
    const storage = memoryStorage();
    storage.setItem(
      legacySettingsKey,
      JSON.stringify({
        filenameTemplate: "é".repeat(81),
        cutStrategy: "unknown",
        muted: "yes",
        appearance: "sepia",
      }),
    );
    storage.setItem(legacyWaveformVisibleKey, "malformed");
    storage.setItem(legacyLoopSelectedSegmentKey, "true");
    storage.setItem(legacyDestinationKey, "../outside");
    vi.stubGlobal("localStorage", storage);
    const { registry, server } = workspace();
    try {
      await Effect.runPromise(
        AtomRegistry.getResult(registry, server.preferences.initialize, {
          suspendOnWaiting: true,
        }),
      );
      expect(registry.get(server.preferences.value)).toEqual({
        ...defaultBrowserPreferences,
        loopSelectedSegment: true,
      });
      expect(JSON.parse(storage.getItem(browserPreferencesKey) ?? "null")).toEqual({
        ...defaultBrowserPreferences,
        loopSelectedSegment: true,
      });
    } finally {
      registry.dispose();
    }
  });

  it("does not import legacy preferences over current data or malformed current data", async () => {
    const storage = memoryStorage();
    const current = { ...defaultBrowserPreferences, appearance: "nord" as const };
    storage.setItem(browserPreferencesKey, JSON.stringify(current));
    storage.setItem(legacySettingsKey, JSON.stringify({ appearance: "dracula" }));
    const getItem = vi.spyOn(storage, "getItem");
    vi.stubGlobal("localStorage", storage);
    const first = workspace();
    try {
      await Effect.runPromise(
        AtomRegistry.getResult(first.registry, first.server.preferences.initialize, {
          suspendOnWaiting: true,
        }),
      );
      expect(first.registry.get(first.server.preferences.value)).toEqual(current);
      expect(getItem).not.toHaveBeenCalledWith(legacySettingsKey);
    } finally {
      first.registry.dispose();
    }

    storage.setItem(browserPreferencesKey, JSON.stringify({ ...current, muted: "yes" }));
    const second = workspace();
    try {
      await Effect.runPromise(
        AtomRegistry.getResult(second.registry, second.server.preferences.initialize, {
          suspendOnWaiting: true,
        }),
      );
      expect(second.registry.get(second.server.preferences.value)).toEqual(
        defaultBrowserPreferences,
      );
      expect(second.registry.get(second.server.preferences.status)).toMatchObject({
        initialized: true,
        failure: { operation: "read" },
      });
      expect(storage.getItem(browserPreferencesKey)).toBe(
        JSON.stringify({ ...current, muted: "yes" }),
      );
    } finally {
      second.registry.dispose();
    }
  });

  it("keeps migrated preferences usable and reports failed migration writes", async () => {
    const storage = memoryStorage();
    storage.setItem(legacySettingsKey, JSON.stringify({ appearance: "dracula" }));
    const setItem = storage.setItem;
    storage.setItem = (key, value) => {
      if (key === browserPreferencesKey)
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      setItem(key, value);
    };
    vi.stubGlobal("localStorage", storage);
    const { registry, server } = workspace();
    try {
      await Effect.runPromise(
        AtomRegistry.getResult(registry, server.preferences.initialize, {
          suspendOnWaiting: true,
        }),
      );
      expect(registry.get(server.preferences.value)).toEqual({
        ...defaultBrowserPreferences,
        appearance: "dracula",
      });
      expect(registry.get(server.preferences.status)).toMatchObject({
        initialized: true,
        write: "failed",
        failure: { operation: "write" },
      });
      expect(storage.getItem(browserPreferencesKey)).toBeNull();
      expect(storage.getItem(legacySettingsKey)).not.toBeNull();
    } finally {
      registry.dispose();
    }
  });

  it("falls back safely for malformed persisted preferences", async () => {
    const storage = memoryStorage();
    storage.setItem(
      browserPreferencesKey,
      JSON.stringify({ ...defaultBrowserPreferences, muted: "yes" }),
    );
    vi.stubGlobal("localStorage", storage);
    const { registry, server } = workspace();
    try {
      await Effect.runPromise(
        AtomRegistry.getResult(registry, server.preferences.initialize, { suspendOnWaiting: true }),
      );
      expect(registry.get(server.preferences.value)).toEqual(defaultBrowserPreferences);
      expect(registry.get(server.preferences.status)).toMatchObject({
        initialized: true,
        failure: { operation: "read" },
      });
    } finally {
      registry.dispose();
    }
  });
});
