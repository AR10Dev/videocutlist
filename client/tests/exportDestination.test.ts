import { describe, expect, it } from "vitest";
import {
  destinationIsConfigured,
  lastDestinationId,
  lastDestinationKey,
  rememberDestination,
} from "../src/features/export/destination";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("export destination preference", () => {
  it("remembers only safe configured-looking opaque IDs", () => {
    const storage = memoryStorage();
    rememberDestination("archive", storage);
    expect(lastDestinationId(storage)).toBe("archive");
    expect(destinationIsConfigured("archive", [{ id: "download" }, { id: "archive" }])).toBe(true);
    expect(destinationIsConfigured("archive", [{ id: "download" }])).toBe(false);

    rememberDestination("/private/exports", storage);
    expect(lastDestinationId(storage)).toBe("archive");
    expect(storage.getItem(lastDestinationKey)).toBe("archive");
  });

  it("ignores malformed stored values", () => {
    const storage = memoryStorage();
    storage.setItem(lastDestinationKey, "../exports");
    expect(lastDestinationId(storage)).toBeUndefined();
  });
});
