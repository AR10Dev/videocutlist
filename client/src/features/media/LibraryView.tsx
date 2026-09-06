import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { ChevronDown, Film, Folder, FolderOpen, LoaderCircle, RefreshCw } from "lucide-solid";
import type { components } from "../../generated/api";
import { createApiClient, resolveBrowserConfiguration } from "../../api";
import { useWorkspace } from "../app/WorkspaceContext";
import { formatLibraryDuration, mediaSummary } from "./model";

type Media = components["schemas"]["Media"];
const api = createApiClient(resolveBrowserConfiguration());

function MediaThumbnail(props: { item: Media }) {
  const [source, setSource] = createSignal<string>();
  createEffect(() => {
    const controller = new AbortController();
    let objectURL: string | undefined;
    setSource();
    void api
      .assetRequest(
        props.item.id,
        "thumbnails",
        {
          startMs: 0,
          durationMs: Math.max(1, Math.min(props.item.durationMs, 120_000)),
          count: 1,
          width: 240,
        },
        { signal: controller.signal },
      )
      .then(async (response) => {
        if (!response.ok || controller.signal.aborted) return;
        objectURL = URL.createObjectURL(await response.blob());
        if (!controller.signal.aborted) setSource(objectURL);
      })
      .catch(() => undefined);
    onCleanup(() => {
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    });
  });
  return (
    <span class="media-thumbnail" aria-hidden="true">
      <Show when={source()} fallback={<Film size={18} />}>
        <img src={source()} alt="" loading="lazy" />
      </Show>
    </span>
  );
}

export function LibraryView() {
  const [explorerOpen, setExplorerOpen] = createSignal(false);
  const {
    library,
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
      aria-label="Media library"
    >
      <div class="panel-heading">
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
          <Show
            when={refreshing() || library.scanActive()}
            fallback={<RefreshCw size={16} aria-hidden="true" />}
          >
            <LoaderCircle class="spin" size={16} aria-hidden="true" />
          </Show>
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
      <Show
        when={
          library.scanActive() ||
          library.importJob()?.state === "failed" ||
          Boolean(library.importJob()?.errorCode) ||
          Boolean(library.importJob()?.validationErrors?.length)
        }
      >
        <Show when={library.scanActive()}>
          <div class="library-scan-state" aria-label="Library scan" role="status">
            <LoaderCircle class="spin" size={16} aria-hidden="true" />
            <span>Indexing media…</span>
            <small>
              {library.importJob()?.indexed ?? 0} indexed ·{" "}
              {Math.round((library.importJob()?.progress ?? 0) * 100)}%
            </small>
            <button
              class="btn btn-ghost btn-xs"
              disabled={library.cancellingImport()}
              onClick={() => void library.cancelImport()}
            >
              Cancel
            </button>
          </div>
        </Show>
        <Show when={library.importJob()?.state === "failed" || library.importJob()?.errorCode}>
          <div class="alert alert-error" role="alert">
            <span>
              Media indexing failed
              {library.importJob()?.errorCode ? ` (${library.importJob()!.errorCode})` : ""}.
              Refresh to try again.
            </span>
            <button class="btn btn-ghost btn-xs" type="button" onClick={() => void refreshMedia()}>
              Retry
            </button>
          </div>
        </Show>
        <For each={library.importJob()?.validationErrors ?? []}>
          {(message) => (
            <p class="field-error" role="alert">
              {message}
            </p>
          )}
        </For>
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
          <ChevronDown size={15} aria-hidden="true" />
          <FolderOpen size={16} aria-hidden="true" />
          <span>All media</span>
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
                      <Folder size={16} aria-hidden="true" />
                      <span>{folder.label}</span>
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
                    <MediaThumbnail item={item} />
                    <span class="media-file-copy">
                      <strong>{item.name}</strong>
                      <span>{formatLibraryDuration(item.durationMs)}</span>
                      <small>{mediaSummary(item)}</small>
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
