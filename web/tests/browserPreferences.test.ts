import { Effect } from "effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api";
import { createServerState } from "../src/app/server";
import { browserPreferencesKey, defaultBrowserPreferences } from "../src/features/settings/model";
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
