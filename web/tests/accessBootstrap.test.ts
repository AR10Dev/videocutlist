import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { authenticationRequiredEvent, type ClientConfiguration } from "../src/api";
import { createAccessBootstrap } from "../src/features/access/bootstrap";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});
function bootstrap() {
  const browser = new EventTarget() as Window;
  vi.stubGlobal("window", browser);
  const configuration: ClientConfiguration = {
    serverBaseUrl: "https://example.test",
    authentication: { type: "none" },
  };
  const registry = AtomRegistry.make();
  const access = createAccessBootstrap(registry, configuration, browser);
  cleanups.push(() => registry.dispose(), access.dispose);
  const outcome = () =>
    Effect.runPromiseExit(
      AtomRegistry.getResult(registry, access.verification, { suspendOnWaiting: true }),
    );
  return { browser, configuration, registry, access, outcome };
}

describe("access bootstrap", () => {
  it("has one verification outcome and only accepts authentication after success", async () => {
    const { browser, configuration, registry, access, outcome } = bootstrap();
    browser.dispatchEvent(new Event(authenticationRequiredEvent));
    const previous = configuration.authentication;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    access.connect("rejected-secret");
    expect(registry.get(access.verification).waiting).toBe(true);
    expect((await outcome())._tag).toBe("Failure");
    expect(configuration.authentication).toBe(previous);
    expect(registry.get(access.required)).toBe(true);
    expect(JSON.stringify(registry.get(access.verification))).not.toContain("rejected-secret");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    access.connect("accepted-secret");
    expect((await outcome())._tag).toBe("Success");
    expect(configuration.authentication).toEqual({ type: "bearer", token: "accepted-secret" });
    expect(registry.get(access.required)).toBe(false);
    const result = registry.get(access.verification);
    expect(AsyncResult.isSuccess(result)).toBe(true);
    if (AsyncResult.isSuccess(result)) expect(result.value).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("accepted-secret");
    browser.dispatchEvent(new Event(authenticationRequiredEvent));
    expect(registry.get(access.required)).toBe(true);
  });

  it("interrupts verification, ignores late success, and removes its single listener", async () => {
    const { browser, configuration, registry, access } = bootstrap();
    let respond!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => (started = resolve));
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        started();
        return new Promise<Response>((resolve) => (respond = resolve));
      }),
    );
    access.connect("late-secret");
    await ready;
    access.dispose();
    access.dispose();
    expect(signal?.aborted).toBe(true);
    respond(new Response(null, { status: 200 }));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(configuration.authentication).toEqual({ type: "none" });
    browser.dispatchEvent(new Event(authenticationRequiredEvent));
    expect(registry.get(access.required)).toBe(false);
    expect(AsyncResult.isInitial(registry.get(access.verification))).toBe(true);
  });

  it("does not disclose native failures or invalid token data", async () => {
    const { access, outcome, registry } = bootstrap();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("native-secret")));
    access.connect("native-secret");
    await outcome();
    expect(JSON.stringify(registry.get(access.verification))).not.toContain("native-secret");
    access.connect("invalid\nsecret");
    expect((await outcome())._tag).toBe("Failure");
    expect(JSON.stringify(registry.get(access.verification))).not.toContain("invalid");
  });
});
