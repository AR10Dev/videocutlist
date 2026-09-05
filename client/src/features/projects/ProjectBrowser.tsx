import { createSignal, For, Show } from "solid-js";
import { createApiClient, resolveBrowserConfiguration } from "../../api";
import type { components } from "../../generated/api";
import { useWorkspace } from "../app/WorkspaceContext";

const api = createApiClient(resolveBrowserConfiguration());

export function ProjectBrowser() {
  const { projects } = useWorkspace();
  const [items, setItems] = createSignal<components["schemas"]["ProjectSummary"][]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const load = async (next?: string) => {
    if (pending()) return;
    setPending(true);
    setMessage("");
    try {
      const response = await api.request(
        `projects?limit=50${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
      );
      if (!response.ok)
        throw new Error("Saved projects could not be loaded. Try Refresh projects.");
      const page = (await response.json()) as components["schemas"]["ProjectPage"];
      setItems((previous) => (next ? [...previous, ...page.items] : page.items));
      setCursor(page.nextCursor);
      if (!page.items.length && !next)
        setMessage("No saved projects yet. Choose media and save your first project.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Saved projects could not be loaded.");
    } finally {
      setPending(false);
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
