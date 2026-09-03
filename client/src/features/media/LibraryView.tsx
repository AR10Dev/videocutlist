import { For, Show } from "solid-js";
import { formatTime } from "../preview/model";
import { useWorkspace } from "../app/WorkspaceContext";

export function LibraryView() {
  const {
    media,
    selected,
    folders,
    activeFolder,
    nextCursor,
    loadingMore,
    refreshing,
    libraryMessage,
    refreshMedia,
    loadFolder,
    chooseMedia,
  } = useWorkspace();
  return (
    <section class="media-panel" aria-labelledby="media-heading">
      <div class="panel-heading">
        <h2 id="media-heading">File explorer</h2>
        <button
          class="icon-button"
          onClick={() => void refreshMedia()}
          disabled={refreshing()}
          aria-label="Refresh media"
        >
          ↻
        </button>
      </div>
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
      <nav class="file-tree" aria-label="Media folders">
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
                    onClick={() => chooseMedia(item)}
                  >
                    {item.name}
                    <span>
                      {formatTime(item.durationMs, item.durationMs)} · {item.container}
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
