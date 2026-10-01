import { RegistryContext, useAtomSet } from "@effect/atom-solid";
import { Effect } from "effect";
import * as Atom from "effect/reactivity/Atom";
import { createSignal, onCleanup, Show, useContext, type JSX } from "solid-js";
import {
  authenticationRequiredEvent,
  apiRequest,
  createApiClient,
  resolveBrowserConfiguration,
} from "../../api";
import { useServerAtom } from "../app/server";

export function AccessGate(props: { renderWorkspace: () => JSX.Element }) {
  const registry = useContext(RegistryContext);
  const [required, setRequired] = createSignal(false);
  const [token, setToken] = createSignal("");
  const verification = Atom.fn((value: string) =>
    Effect.gen(function* () {
      const configuration = resolveBrowserConfiguration();
      const authentication = { type: "bearer" as const, token: value };
      const response = yield* apiRequest(
        createApiClient({ ...configuration, authentication }),
        "settings",
      );
      if (!response.ok)
        return yield* Effect.fail(
          new Error(
            response.status === 401
              ? "Access token was not accepted. Check the deployment token and try again."
              : "Server access could not be verified. Check the connection and try again.",
          ),
        );
      configuration.authentication = authentication;
    }),
  );
  const verify = useAtomSet(() => verification, { mode: "promise" });
  const state = useServerAtom(() => verification);
  const pending = state.waiting;
  const error = () => (pending() ? "" : (state.error()?.message ?? ""));
  const requireAccess = () => setRequired(true);
  window.addEventListener(authenticationRequiredEvent, requireAccess);
  onCleanup(() => {
    window.removeEventListener(authenticationRequiredEvent, requireAccess);
    registry.set(verification, Atom.Interrupt);
  });

  const connect = async (event: SubmitEvent) => {
    event.preventDefault();
    if (pending()) return;
    try {
      await verify(token());
      setToken("");
      registry.set(verification, Atom.Reset);
      setRequired(false);
    } catch {
      // The command atom exposes a safe error and owns cancellation on cleanup.
    }
  };

  return (
    <Show
      when={!required()}
      fallback={
        <main class="grid min-h-screen place-items-center p-6">
          <form class="grid w-full max-w-md gap-4" onSubmit={(event) => void connect(event)}>
            <h1 class="text-2xl font-bold">VideoCutlist access</h1>
            <p>Enter the bearer token configured by the server administrator.</p>
            <label for="server-access-token">Access token</label>
            <input
              id="server-access-token"
              class="input w-full"
              type="password"
              autocomplete="off"
              required
              value={token()}
              onInput={(event) => setToken(event.currentTarget.value)}
              aria-describedby="server-access-help"
              disabled={pending()}
            />
            <p id="server-access-help" class="text-sm">
              The token stays in this tab’s memory, not browser storage. Reloading asks again. If
              your deployment uses proxy sign-in, authenticate there and reload instead.
            </p>
            <Show when={error()}>
              <div class="alert alert-error" role="alert">
                {error()}
              </div>
            </Show>
            <button class="btn" type="submit" disabled={pending()}>
              {pending() ? "Checking access…" : "Open workspace"}
            </button>
          </form>
        </main>
      }
    >
      {props.renderWorkspace()}
    </Show>
  );
}
