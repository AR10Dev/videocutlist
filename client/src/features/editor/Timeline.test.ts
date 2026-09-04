import { describe, expect, it } from "vitest";
import { timelineTimeFromPointer } from "./timeline";

describe("timelineTimeFromPointer", () => {
  it("maps and clamps pointer positions to media time", () => {
    expect(timelineTimeFromPointer(150, 100, 200, 10_000)).toBe(2_500);
    expect(timelineTimeFromPointer(0, 100, 200, 10_000)).toBe(0);
    expect(timelineTimeFromPointer(400, 100, 200, 10_000)).toBe(10_000);
  });
});
