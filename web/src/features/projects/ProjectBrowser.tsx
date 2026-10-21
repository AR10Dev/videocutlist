import { useAtomValue } from "@effect/atom-solid";
import { For, Show, onCleanup } from "solid-js";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useServerAtom } from "../../app/server";
import { useWorkspace } from "../../app/WorkspaceContext";
import { useConfirmation, discardChanges } from "../../components/ConfirmDialog";
import { createProjectBrowser } from "./browser";

export function ProjectBrowser() {
  const { projects, server, dirty, workspaceIdentity } = useWorkspace();
  const confirm = useConfirmation();
  const browser = createProjectBrowser(server);
  const page = useAtomValue(() => browser.page);
  const operation = useServerAtom(() => browser.result);
  const message = () => {
    if (operation.error()) return operation.error()!.message;
    if (AsyncResult.isSuccess(operation.result()) && !page().items.length)
      return "No saved projects yet. Choose media and save your first project.";
    return "";
  };
  onCleanup(browser.close);
  return (
    <details
      open
      onToggle={(event) => {
        if (event.currentTarget.open) browser.open();
        else browser.close();
      }}
    >
      <summary>Browse saved projects</summary>
      <button class="btn btn-ghost btn-sm" disabled={operation.waiting()} onClick={browser.refresh}>
        Refresh projects
      </button>
      <Show when={operation.waiting()}>
        <p role="status">Loading projects…</p>
      </Show>
      <Show when={message()}>
        <p role="status">{message()}</p>
      </Show>
      <ul class="project-items" aria-label="Saved projects">
        <For each={page().items}>
          {(project) => (
            <li>
              <button
                class="btn btn-ghost btn-sm"
                onClick={async () => {
                  const identity = server.registry.get(workspaceIdentity);
                  const accepted = !dirty() || (await confirm(discardChanges));
                  if (identity === server.registry.get(workspaceIdentity))
                    void projects.loadProject(project.id, undefined, accepted);
                }}
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
      <Show when={page().nextCursor}>
        <button
          class="btn btn-ghost btn-sm"
          disabled={operation.waiting()}
          onClick={browser.loadMore}
        >
          Load more projects
        </button>
      </Show>
    </details>
  );
}
