import { describe, expect, it } from "vitest";
import { jobPollInterval } from "../src/features/queue/jobPolling";

describe("job polling", () => {
  it("polls queued and running jobs", () => {
    expect(jobPollInterval({ state: "queued" }, 1000)).toBe(1000);
    expect(jobPollInterval({ state: "running" }, 500)).toBe(500);
  });

  it("stops polling terminal or missing jobs", () => {
    for (const state of ["succeeded", "failed", "cancelled"]) {
      expect(jobPollInterval({ state }, 1000)).toBe(false);
    }
    expect(jobPollInterval(undefined, 1000)).toBe(false);
  });
});
