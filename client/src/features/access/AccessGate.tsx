import { createSignal, onCleanup, Show, type JSX } from "solid-js";
import { useQueryClient } from "@tanstack/solid-query";
import {
  authenticationRequiredEvent,
  createApiClient,
  resolveBrowserConfiguration,
} from "../../api";

export function AccessGate(props: { renderWorkspace: () => JSX.Element }) {
  const queryClient = useQueryClient();
  const [required, setRequired] = createSignal(false);
  const [token, setToken] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  let request: AbortController | undefined;
  const requireAccess = () => setRequired(true);
  window.addEventListener(authenticationRequiredEvent, requireAccess);
  onCleanup(() => {
    window.removeEventListener(authenticationRequiredEvent, requireAccess);
    request?.abort();
  });

  const connect = async (event: SubmitEvent) => {
    event.preventDefault();
    if (pending()) return;
    setPending(true);
    setError("");
    const controller = new AbortController();
    request = controller;
    try {
      const configuration = resolveBrowserConfiguration();
      const authentication = { type: "bearer" as const, token: token() };
      const response = await createApiClient({ ...configuration, authentication }).request(
        "settings",
        { signal: controller.signal },
      );
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Access token was not accepted. Check the deployment token and try again."
            : "Server access could not be verified. Check the connection and try again.",
        );
      if (controller.signal.aborted) return;
      configuration.authentication = authentication;
      setToken("");
      queryClient.clear();
      setRequired(false);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Server access could not be verified.");
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (request === controller) request = undefined;
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
