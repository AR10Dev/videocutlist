import { Clock, Effect, Exit, Layer } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "@effect/vitest";
import { createApiClient } from "../src/api";
import { createServerState, pollAtom } from "../src/features/app/server";

describe("workspace server atoms", () => {
  it.effect("recovers polling failures and stops after the terminal result", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const runtime = Atom.runtime(Layer.succeed(Clock.Clock, clock));
      let requests = 0;
      const fetch = Effect.suspend(() => {
        requests++;
        return requests === 1
          ? Effect.fail(new Error("Status temporarily unavailable."))
          : Effect.succeed({ state: requests === 2 ? "running" : "succeeded" });
      });
      const job = pollAtom(runtime, fetch, (value) => value.state === "running", 100);
      registry.mount(job);
      const initial = yield* Effect.exit(
        AtomRegistry.getResult(registry, job, { suspendOnWaiting: true }),
      );
      expect(Exit.isFailure(initial)).toBe(true);
      yield* clock.adjust(100);
      const running = yield* AtomRegistry.getResult(registry, job, { suspendOnWaiting: true });
      expect(running.state).toBe("running");
      yield* clock.adjust(100);
      const terminal = yield* AtomRegistry.getResult(registry, job, { suspendOnWaiting: true });
      expect(terminal.state).toBe("succeeded");
      yield* clock.adjust(1_000);
      expect(requests).toBe(3);
    }),
  );

  it("disposing a workspace aborts its in-flight server reads", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let aborted = false;
    const api = createApiClient(
      { serverBaseUrl: "https://example.test", authentication: { type: "none" } },
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("Request cancelled.", "AbortError"));
            },
            { once: true },
          );
          requestStarted();
        }),
    );
    const registry = AtomRegistry.make();
    const server = createServerState(api, registry);
    registry.mount(server.media("m_current"));
    await started;
    registry.dispose();
    expect(aborted).toBe(true);
  });
});
