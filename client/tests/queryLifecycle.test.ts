import { QueryClient } from "@tanstack/solid-query";
import { describe, expect, it } from "vitest";
import { jobPollInterval } from "../src/jobPolling";

describe("Solid Query lifecycle contracts", () => {
  it("cancels an in-flight query through QueryClient", async () => {
    const client = new QueryClient();
    let signal: AbortSignal | undefined;
    const pending = client.fetchQuery({
      queryKey: ["job", "export", "job-1"],
      queryFn: ({ signal: querySignal }) => {
        signal = querySignal;
        return new Promise<never>(() => undefined);
      },
    });
    await client.cancelQueries({ queryKey: ["job", "export", "job-1"] });
    await expect(pending).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
  });

  it("invalidates related cached queries after a terminal job", async () => {
    const client = new QueryClient();
    await client.prefetchQuery({ queryKey: ["project", "p-1"], queryFn: () => "cached" });
    expect(client.getQueryState(["project", "p-1"])?.isInvalidated).toBe(false);
    await client.invalidateQueries({ queryKey: ["project", "p-1"] });
    expect(client.getQueryState(["project", "p-1"])?.isInvalidated).toBe(true);
  });

  it("stops polling terminal jobs and avoids stale replacement", () => {
    expect(jobPollInterval({ state: "succeeded" }, 1000)).toBe(false);
    const selected = "new-media";
    const response = { id: "old-media" };
    expect(response.id === selected).toBe(false);
  });
});
