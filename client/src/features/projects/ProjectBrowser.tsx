import { createSignal, For, Show, onCleanup } from "solid-js";
import { Effect } from "effect";
import { readServerAtom } from "../app/server";
import type { components } from "../../generated/api";
import { useWorkspace } from "../app/WorkspaceContext";

export function ProjectBrowser() {
  const { projects, server } = useWorkspace();
  const [pending, setPending] = createSignal(false);
  let disposed = false;
  let activeRead: AbortController | undefined;
  onCleanup(() => {
    disposed = true;
    activeRead?.abort();
  });
  const [items, setItems] = createSignal<components["schemas"]["ProjectSummary"][]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [message, setMessage] = createSignal("");
  const load = async (next?: string) => {
    if (pending()) return;
    setPending(true);
    const read = new AbortController();
    activeRead = read;
    try {
      const resource = server.projectPage({
        limit: 50,
        ...(next !== undefined ? { cursor: next } : {}),
      });
      server.registry.refresh(resource);
      const result = await Effect.runPromise(readServerAtom(server, resource), {
        signal: read.signal,
      });
      if (disposed) return;
      setItems((previous) => (next ? [...previous, ...result.items] : [...result.items]));
      setCursor(result.nextCursor);
      setMessage(
        !result.items.length && !next
          ? "No saved projects yet. Choose media and save your first project."
          : "",
      );
    } catch {
      if (!disposed) setMessage("Saved projects could not be loaded. Try Refresh projects.");
    } finally {
      if (activeRead === read) activeRead = undefined;
      if (!disposed) setPending(false);
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
