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
        <h2 id="media-heading">Media explorer</h2>
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
      <Show when={!selected()}>
        <section class="library-setup" aria-labelledby="library-setup-heading">
          <h3 id="library-setup-heading">Server media library</h3>
          <p>
            VideoCutlist indexes videos mounted on the server; the browser does not upload or choose
            a host folder.
          </p>
          <p role="status">{libraryMessage()}</p>
        </section>
      </Show>
      <Show when={selected()}>
        {(item) => (
          <div class="current-video" aria-label="Current video">
            <strong>{item().name}</strong>
            <span>
              {formatLibraryDuration(item().durationMs)} · {mediaSummary(item())}
            </span>
          </div>
        )}
      </Show>
      <nav class="file-tree" classList={{ "is-open": explorerOpen() }} aria-label="Media folders">
        <button class="folder" aria-current="page" onClick={() => void loadFolder()}>
          ⌄ Server media library
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
          <span class="folder-label">{activeFolder() ? "Videos in folder" : "Indexed videos"}</span>
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
