import { For, Show, createSignal } from "solid-js";
import { useWorkspace } from "../app/WorkspaceContext";
import { formatLibraryDuration, mediaSummary } from "./model";

export function LibraryView() {
  const [explorerOpen, setExplorerOpen] = createSignal(false);
  const {
    library,
    media,
    selected,
    activeItemId,
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
    addMediaToProject: workspaceAddMediaToProject,
  } = useWorkspace();
  return (
    <section
      class="media-panel"
      classList={{ "has-selection": Boolean(selected()), "explorer-open": explorerOpen() }}
      aria-label="Media library"
    >
      <div class="panel-heading">
        <Show when={selected() && !activeItemId()}>
          <button class="btn btn-primary btn-sm" onClick={() => workspaceAddMediaToProject()}>
            Add to project
          </button>
        </Show>
        <Show when={selected()}>
          <button
            class="change-video btn btn-ghost btn-sm"
            onClick={() => setExplorerOpen((open) => !open)}
          >
            {explorerOpen() ? "Close" : "Change video"}
          </button>
        </Show>
        <button
          class="icon-button btn btn-ghost btn-square btn-sm"
          title="Refresh media library"
          onClick={() => void refreshMedia()}
          disabled={refreshing() || library.scanActive()}
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
      <Show when={library.libraryError() || library.scanError()}>
        <p role="alert">{library.libraryError() || library.scanError()}</p>
      </Show>
      <Show when={library.importJob()}>
        {(job) => (
          <div aria-label="Library scan">
            <p role="status">
              Scan {job().state} · {job().indexed} files indexed ·{" "}
              {Math.round(job().progress * 100)}%
            </p>
            <Show when={job().errorCode}>
              <p role="alert">
                Scan failed: {job().errorCode}. Check server media access and refresh to retry.
              </p>
            </Show>
            <For each={job().validationErrors ?? []}>
              {(message) => <p role="alert">{message}</p>}
            </For>
            <Show when={library.scanActive()}>
              <button
                class="btn btn-ghost btn-sm"
                disabled={library.cancellingImport()}
                onClick={() => void library.cancelImport()}
              >
                Cancel scan
              </button>
            </Show>
          </div>
        )}
      </Show>
      <Show when={!selected() && media().length === 0 && !library.libraryError()}>
        <div class="library-setup" role="region" aria-label="Media library status">
          <p role="status">{libraryMessage()}</p>
        </div>
      </Show>
      <nav class="file-tree" classList={{ "is-open": explorerOpen() }} aria-label="Media folders">
        <button
          class="folder btn btn-ghost btn-sm"
          aria-current="page"
          onClick={() => void loadFolder()}
        >
          ⌄ All media
        </button>
        <div class="folder-contents">
          <Show when={folders().length}>
            <ul class="folder-list" aria-label="Virtual folders">
              <For each={folders()}>
                {(folder) => (
                  <li>
                    <button
                      class="folder btn btn-ghost btn-sm"
                      onClick={() => void loadFolder(folder.id)}
                    >
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
                    class="btn btn-ghost btn-sm justify-start"
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
          class="btn btn-ghost btn-sm"
          disabled={loadingMore()}
          onClick={() => void loadFolder(activeFolder(), nextCursor())}
        >
          {loadingMore() ? "Loading more…" : "Load more"}
        </button>
      </Show>
    </section>
  );
}
