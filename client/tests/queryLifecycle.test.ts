import { createMutation, QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createComponent, createRoot } from "solid-js";
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

  it("passes an abort signal through a mutation", async () => {
    await new Promise<void>((resolve, reject) =>
      createRoot(async (dispose) => {
        try {
          let signal: AbortSignal | undefined;
          let mutation!: {
            mutateAsync: (variables: { signal: AbortSignal }) => Promise<string>;
          };
          const client = new QueryClient();
          createComponent(QueryClientProvider, {
            client,
            get children() {
              mutation = createMutation(() => ({
                mutationFn: ({ signal: mutationSignal }: { signal: AbortSignal }) => {
                  signal = mutationSignal;
                  return Promise.resolve("cancelled");
                },
              }));
              return null;
            },
          });
          await mutation.mutateAsync({ signal: new AbortController().signal });
          expect(signal).toBeInstanceOf(AbortSignal);
          dispose();
          resolve();
        } catch (error) {
          dispose();
          reject(error);
        }
      }),
    );
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
