import { describe, expect, it } from "vitest";
import {
  destinationIsConfigured,
  lastDestinationId,
  lastDestinationKey,
  rememberDestination,
} from "../src/features/export/destination";
import { memoryStorage } from "./memoryStorage";

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
