import { createSignal, For, Show, onCleanup, useContext } from "solid-js";
import { RegistryContext, useAtomSet } from "@effect/atom-solid";
import { Effect } from "effect";
import * as Atom from "effect/reactivity/Atom";
import { apiJson, createApiClient, resolveBrowserConfiguration } from "../../api";
import { useServerAtom } from "../app/server";
import type { components } from "../../generated/api";
import { useWorkspace } from "../app/WorkspaceContext";

export function ProjectBrowser() {
  const { projects } = useWorkspace();
  const api = createApiClient(resolveBrowserConfiguration());
  const registry = useContext(RegistryContext);
  const page = Atom.fn((next: string | undefined) =>
    apiJson<components["schemas"]["ProjectPage"]>(
      api,
      `projects?limit=50${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
    ).pipe(
      Effect.mapError(() => new Error("Saved projects could not be loaded. Try Refresh projects.")),
    ),
  );
  const fetchPage = useAtomSet(() => page, { mode: "promise" });
  const state = useServerAtom(() => page);
  const pending = state.waiting;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    registry.set(page, Atom.Interrupt);
  });
  const [items, setItems] = createSignal<components["schemas"]["ProjectSummary"][]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [message, setMessage] = createSignal("");
  const load = async (next?: string) => {
    if (pending()) return;
    try {
      const result = await fetchPage(next);
      if (disposed) return;
      setItems((previous) => (next ? [...previous, ...result.items] : result.items));
      setCursor(result.nextCursor);
      setMessage(
        !result.items.length && !next
          ? "No saved projects yet. Choose media and save your first project."
          : "",
      );
    } catch (error) {
      if (!disposed)
        setMessage(error instanceof Error ? error.message : "Saved projects could not be loaded.");
    }
  };
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>Browse saved projects</summary>
      <button class="btn btn-ghost btn-sm" disabled={pending()} onClick={() => void load()}>
        Refresh projects
      </button>
      <Show when={pending()}>
        <p role="status">Loading projects…</p>
      </Show>
      <Show when={message()}>
        <p role="status">{message()}</p>
      </Show>
      <ul class="project-items" aria-label="Saved projects">
        <For each={items()}>
          {(project) => (
            <li>
              <button
                class="btn btn-ghost btn-sm"
                onClick={() => void projects.loadProject(project.id)}
              >
                {project.name}
              </button>
              <small>
                Revision {project.revision} · {new Date(project.updatedAt).toLocaleDateString()}
              </small>
            </li>
          )}
        </For>
      </ul>
      <Show when={cursor()}>
        <button
          class="btn btn-ghost btn-sm"
          disabled={pending()}
          onClick={() => void load(cursor()!)}
        >
          Load more projects
        </button>
      </Show>
    </details>
  );
}
