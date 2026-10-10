import { Effect } from "effect";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import {
  authenticationRequiredEvent,
  apiRequest,
  createApiClient,
  type ClientConfiguration,
} from "../../api";

/** Pre-workspace exception: native command atoms use the outer provider's registry.
 * It outlives disposable workspace providers and never persists authentication. */
export function createAccessBootstrap(
  registry: AtomRegistry.AtomRegistry,
  configuration: ClientConfiguration,
  browser: Window = window,
) {
  const required = Atom.keepAlive(Atom.make(false));
  let candidate = "";
  let disposed = false;
  // The command input/output is void: credentials are consumed, not retained in command data.
  const verification = Atom.fn(() =>
    Effect.suspend(() => {
      const token = candidate;
      candidate = "";
      return Effect.gen(function* () {
        const authentication = { type: "bearer" as const, token };
        const api = yield* Effect.try({
          try: () => createApiClient({ ...configuration, authentication }),
          catch: () =>
            new Error("Access token was not accepted. Check the deployment token and try again."),
        });
        const response = yield* apiRequest(api, "settings").pipe(
          Effect.mapError(
            () =>
              new Error("Server access could not be verified. Check the connection and try again."),
          ),
        );
        if (!response.ok)
          return yield* Effect.fail(
            new Error(
              response.status === 401
                ? "Access token was not accepted. Check the deployment token and try again."
                : "Server access could not be verified. Check the connection and try again.",
            ),
          );
        if (disposed) return;
        configuration.authentication = authentication;
        registry.set(required, false);
      });
    }),
  );
  const release = registry.mount(verification);
  const requireAccess = () => registry.set(required, true);
  browser.addEventListener(authenticationRequiredEvent, requireAccess);
  return {
    required,
    verification,
    connect(token: string) {
      if (disposed || registry.get(verification).waiting) return;
      candidate = token;
      registry.set(verification, undefined);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      candidate = "";
      browser.removeEventListener(authenticationRequiredEvent, requireAccess);
      registry.set(verification, Atom.Interrupt);
      registry.set(verification, Atom.Reset);
      release();
    },
  };
}

export type AccessBootstrap = ReturnType<typeof createAccessBootstrap>;
