import { For, Show, createSignal } from "solid-js";
import { useWorkspace } from "../app/WorkspaceContext";
import { formatLibraryDuration, mediaSummary } from "./model";

export function LibraryView() {
  const [explorerOpen, setExplorerOpen] = createSignal(false);
  const {
    media,
    selected,
    folders,
    activeFolder,
    nextCursor,
    loadingMore,
    refreshing,
    libraryMessage,
    status,
    refreshMedia,
    loadFolder,
    chooseMedia,
  } = useWorkspace();
  return (
    <section
      class="media-panel"
      classList={{ "has-selection": Boolean(selected()), "explorer-open": explorerOpen() }}
      aria-labelledby="media-heading"
    >
      <div class="panel-heading">
        <h2 id="media-heading" tabIndex={-1}>
          Media
        </h2>
        <Show when={selected()}>
          <button class="change-video" onClick={() => setExplorerOpen((open) => !open)}>
            {explorerOpen() ? "Close" : "Change video"}
          </button>
        </Show>
        <button
          class="icon-button"
          onClick={() => void refreshMedia()}
          disabled={refreshing()}
          aria-label="Refresh media"
        >
          ↻
        </button>
      </div>
      <Show
        when={
          status().startsWith("Media refresh") ||
          status() === "You are not allowed to refresh media."
        }
      >
        <p role="status">{status()}</p>
      </Show>
      <Show when={!selected() && media().length === 0}>
        <div class="library-setup" role="region" aria-label="Media library status">
          <p role="status">{libraryMessage()}</p>
        </div>
      </Show>
      <nav class="file-tree" classList={{ "is-open": explorerOpen() }} aria-label="Media folders">
        <button class="folder" aria-current="page" onClick={() => void loadFolder()}>
          ⌄ All media
        </button>
        <div class="folder-contents">
          <Show when={folders().length}>
            <ul class="folder-list" aria-label="Virtual folders">
              <For each={folders()}>
                {(folder) => (
                  <li>
                    <button class="folder" onClick={() => void loadFolder(folder.id)}>
                      {folder.label}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={activeFolder()}>
            <span class="folder-label">Videos in folder</span>
          </Show>
          <ul class="media-list" aria-label="Media list">
            <For each={media()}>
              {(item) => (
                <li>
                  <button
                    aria-pressed={selected()?.id === item.id ? "true" : "false"}
                    aria-label={`Select ${item.name}`}
                    onClick={() => {
                      chooseMedia(item);
                      setExplorerOpen(false);
                    }}
                  >
                    <strong>{item.name}</strong>
                    <span>
                      {formatLibraryDuration(item.durationMs)} · {mediaSummary(item)}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </nav>
      <Show when={nextCursor()}>
        <button
          disabled={loadingMore()}
          onClick={() => void loadFolder(activeFolder(), nextCursor())}
        >
          {loadingMore() ? "Loading more…" : "Load more"}
        </button>
      </Show>
    </section>
  );
}
