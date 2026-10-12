import { Cause, Effect, Exit } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api";
import { createServerState, runGeneratedRequest, serverResultError } from "../src/app/server";

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resume) => (resolve = resume));
  return { promise, resolve };
};

function trackedServer() {
  const configuration = {
    serverBaseUrl: "https://example.test",
    authentication: { type: "none" as const },
  };
  const registry = AtomRegistry.make();
  const server = createServerState(createApiClient(configuration), registry, configuration);
  const mount = registry.mount.bind(registry);
  let active = 0;
  const spy = vi.spyOn(registry, "mount").mockImplementation((atom) => {
    const release = mount(atom);
    if (atom !== server.generatedApi.runtime) return release;
    active++;
    return () => {
      active--;
      release();
    };
  });
  return {
    server,
    active: () => active,
    dispose: () => {
      registry.dispose();
      spy.mockRestore();
    },
  };
}

describe("server result errors", () => {
  it("returns no error for initial or successful results", () => {
    expect(serverResultError(AsyncResult.initial())).toBeUndefined();
    expect(serverResultError(AsyncResult.success("value"))).toBeUndefined();
  });

  it("preserves Error identity and hides arbitrary failure values", () => {
    const error = new Error("Public message");
    expect(serverResultError(AsyncResult.failure(Cause.fail(error)))).toBe(error);
    const fallback = serverResultError(AsyncResult.failure(Cause.fail("private details")));
    expect(fallback?.message).toBe("Request could not be completed.");
    expect(fallback?.message).not.toContain("private details");
  });
});

describe("scoped generated requests", () => {
  it.each(["success", "failure", "interruption"] as const)(
    "holds the runtime through the request and releases on %s",
    async (outcome) => {
      const tracked = trackedServer();
      const started = deferred<void>();
      const finish = deferred<void>();
      const abort = new AbortController();
      const failure = new Error("Request failed.");
      try {
        const request = tracked.server.generatedApi.use(() =>
          Effect.sync(() => started.resolve()).pipe(
            Effect.andThen(Effect.promise(() => finish.promise)),
            Effect.andThen(outcome === "failure" ? Effect.fail(failure) : Effect.succeed("done")),
          ),
        );
        const result = Effect.runPromiseExit(runGeneratedRequest(tracked.server, request), {
          signal: abort.signal,
        });
        await started.promise;
        expect(tracked.active()).toBe(1);
        if (outcome === "interruption") abort.abort();
        else finish.resolve();
        const exit = await result;
        if (outcome === "success") {
          expect(exit).toEqual(Exit.succeed("done"));
        } else {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            if (outcome === "failure") expect(Cause.squash(exit.cause)).toBe(failure);
            else expect(Cause.hasInterrupts(exit.cause)).toBe(true);
          }
        }
        expect(tracked.active()).toBe(0);
      } finally {
        abort.abort();
        finish.resolve();
        tracked.dispose();
      }
    },
  );

  it("lets a later sibling fail without aborting the earlier pending request", async () => {
    const tracked = trackedServer();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const firstFinish = deferred<void>();
    const secondFinish = deferred<void>();
    try {
      const first = Effect.runPromise(
        runGeneratedRequest(
          tracked.server,
          tracked.server.generatedApi.use(() =>
            Effect.sync(() => firstStarted.resolve()).pipe(
              Effect.andThen(Effect.promise(() => firstFinish.promise)),
              Effect.as("first"),
            ),
          ),
        ),
      );
      const second = Effect.runPromiseExit(
        runGeneratedRequest(
          tracked.server,
          tracked.server.generatedApi.use(() =>
            Effect.sync(() => secondStarted.resolve()).pipe(
              Effect.andThen(Effect.promise(() => secondFinish.promise)),
              Effect.andThen(Effect.fail(new Error("second failed"))),
            ),
          ),
        ),
      );
      await Promise.all([firstStarted.promise, secondStarted.promise]);
      expect(tracked.active()).toBe(2);
      secondFinish.resolve();
      expect(Exit.isFailure(await second)).toBe(true);
      expect(tracked.active()).toBe(1);
      firstFinish.resolve();
      expect(await first).toBe("first");
      expect(tracked.active()).toBe(0);
    } finally {
      firstFinish.resolve();
      secondFinish.resolve();
      tracked.dispose();
    }
  });
});
