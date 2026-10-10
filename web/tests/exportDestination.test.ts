import { describe, expect, it } from "vitest";
import { destinationIsConfigured, validDestinationId } from "../src/features/export/destination";

describe("export destination preference", () => {
  it("accepts only safe opaque IDs and detects configured destinations", () => {
    expect(validDestinationId("archive")).toBe(true);
    expect(validDestinationId("/private/exports")).toBe(false);
    expect(validDestinationId("../exports")).toBe(false);
    expect(validDestinationId("unsafe\u007f")).toBe(false);
    expect(destinationIsConfigured("archive", [{ id: "download" }, { id: "archive" }])).toBe(true);
    expect(destinationIsConfigured("archive", [{ id: "download" }])).toBe(false);
  });
});
