import { createMutation, QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createComponent, createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import {
  abortAndClear,
  abortCancellationControllers,
  cancellationIsCurrent,
} from "../src/features/queue/cancellation";
import { jobPollInterval } from "../src/features/queue/jobPolling";
import { cancelJobLifecycle } from "../src/features/queue/queryLifecycle";

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

  it("runs production cancellation with abort and related invalidation", async () => {
    const controller = new AbortController();
    const calls: string[][] = [];
    let receivedSignal: AbortSignal | undefined;
    await cancelJobLifecycle({
      jobId: "job-1",
      signal: controller.signal,
      cancel: async (id, signal) => {
        receivedSignal = signal;
        calls.push(["delete", id]);
        return new Response(null, { status: 204 });
      },
      cancelQueries: async ({ queryKey }) => calls.push(["cancel", ...queryKey.map(String)]),
      invalidateQueries: async ({ queryKey }) =>
        calls.push(["invalidate", ...queryKey.map(String)]),
      jobQueryKey: ["job", "export", "job-1"],
      projectQueryKey: ["project", "p-1"],
    });
    expect(receivedSignal).toBe(controller.signal);
    expect(calls).toEqual([
      ["delete", "job-1"],
      ["cancel", "job", "export", "job-1"],
      ["invalidate", "job", "export", "job-1"],
      ["invalidate", "project", "p-1"],
      ["invalidate", "media"],
    ]);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it("aborts and clears cancellation controllers when context changes", () => {
    const controller = new AbortController();
    expect(abortAndClear(controller)).toBeUndefined();
    expect(controller.signal.aborted).toBe(true);
    expect(cancellationIsCurrent(controller, controller)).toBe(false);
    expect(abortAndClear()).toBeUndefined();
  });

  it("aborts pending production cancellation and rejects late stale writes", async () => {
    const controller = new AbortController();
    let resolveDelete!: (response: Response) => void;
    let receivedSignal: AbortSignal | undefined;
    let stateWrites = 0;
    const pending = cancelJobLifecycle({
      jobId: "job-1",
      signal: controller.signal,
      cancel: async (_id, signal) => {
        receivedSignal = signal;
        return new Promise<Response>((resolve) => {
          resolveDelete = resolve;
        });
      },
      cancelQueries: async () => undefined,
      invalidateQueries: async () => undefined,
      jobQueryKey: ["job", "export", "job-1"],
      projectQueryKey: ["project", "p-1"],
    });

    abortAndClear(controller);
    resolveDelete(new Response(null, { status: 204 }));
    await pending;

    expect(receivedSignal?.aborted).toBe(true);
    if (cancellationIsCurrent(controller, controller)) stateWrites++;
    expect(stateWrites).toBe(0);
  });

  it("aborts both cancellation controllers during application cleanup", () => {
    const exportController = new AbortController();
    const detectionController = new AbortController();
    expect(abortCancellationControllers(exportController, detectionController)).toEqual([
      undefined,
      undefined,
    ]);
    expect(exportController.signal.aborted).toBe(true);
    expect(detectionController.signal.aborted).toBe(true);
  });

  it("rejects completion from a discarded cancellation context", () => {
    const previous = new AbortController();
    const current = new AbortController();
    expect(cancellationIsCurrent(previous, current)).toBe(false);
    expect(cancellationIsCurrent(current, current)).toBe(true);
    abortAndClear(current);
    expect(cancellationIsCurrent(current, current)).toBe(false);
  });

  it("keeps delayed query results isolated from a newer selection", async () => {
    const client = new QueryClient();
    let releaseOld!: () => void;
    const oldResult = client.fetchQuery({
      queryKey: ["media", "old-media"],
      queryFn: () =>
        new Promise<{ id: string }>((resolve) => {
          releaseOld = () => resolve({ id: "old-media" });
        }),
    });
    const newResult = await client.fetchQuery({
      queryKey: ["media", "new-media"],
      queryFn: () => Promise.resolve({ id: "new-media" }),
    });
    expect(newResult.id).toBe("new-media");
    expect(client.getQueryData(["media", "new-media"])).toEqual({ id: "new-media" });
    releaseOld();
    await oldResult;
  });

  it("stops polling terminal jobs", () => {
    expect(jobPollInterval({ state: "succeeded" }, 1000)).toBe(false);
  });
});
