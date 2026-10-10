import { useAtomValue } from "@effect/atom-solid";
import { Show, type JSX } from "solid-js";
import { useServerAtom } from "../app/server";
import type { AccessBootstrap } from "./bootstrap";

export function AccessGate(props: { access: AccessBootstrap; renderWorkspace: () => JSX.Element }) {
  const required = useAtomValue(() => props.access.required);
  const state = useServerAtom(() => props.access.verification);
  const pending = state.waiting;
  const error = () => (pending() ? "" : (state.error()?.message ?? ""));
  let input!: HTMLInputElement;
  const connect = (event: SubmitEvent) => {
    event.preventDefault();
    if (pending()) return;
    const token = input.value;
    input.value = "";
    props.access.connect(token);
  };

  return (
    <Show
      when={!required()}
      fallback={
        <main class="grid min-h-screen place-items-center p-6">
          <form class="grid w-full max-w-md gap-4" onSubmit={connect}>
            <h1 class="text-2xl font-bold">VideoCutlist access</h1>
            <p>Enter the bearer token configured by the server administrator.</p>
            <label for="server-access-token">Access token</label>
            <input
              id="server-access-token"
              class="input w-full"
              type="password"
              autocomplete="off"
              required
              ref={(element) => (input = element)}
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
