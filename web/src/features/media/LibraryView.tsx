import { useAtomValue } from "@effect/atom-solid";
import type * as EffectApiTypes from "../../generated/effect-api";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { ChevronDown, Film, Folder, FolderOpen, LoaderCircle, RefreshCw } from "lucide-solid";
import { Option } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { ServerState } from "../../app/server";
import { createApiClient, resolveBrowserConfiguration, type ApiClient } from "../../api";
import { useWorkspace } from "../../app/WorkspaceContext";
import { formatLibraryDuration, mediaSummary } from "./model";
import { libraryThumbnail } from "./thumbnail";

type Media = EffectApiTypes.Media;

function MediaThumbnail(props: { item: Media; api: ApiClient; server: ServerState }) {
  const [visible, setVisible] = createSignal(false);
  let thumbnail!: HTMLSpanElement;
  onMount(() => {
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    });
    observer.observe(thumbnail);
    onCleanup(() => observer.disconnect());
  });
  const empty = Atom.make(AsyncResult.success<string | undefined>(undefined));
  const resource = createMemo(() =>
    visible() ? libraryThumbnail(props.server, props.api, props.item) : empty,
  );
  const result = useAtomValue(resource);
  const source = () =>
    result().waiting ? undefined : Option.getOrUndefined(AsyncResult.value(result()));
  return (
    <span ref={(element) => (thumbnail = element)} class="media-thumbnail" aria-hidden="true">
      <Show when={source()} fallback={<Film size={18} />}>
        <img src={source()} alt="" loading="lazy" />
      </Show>
    </span>
  );
}

export function LibraryView() {
  const api = createApiClient(resolveBrowserConfiguration());
  const [explorerOpen, setExplorerOpen] = createSignal(false);
  const workspace = useWorkspace();
  const { library, visibleMedia, selected, status, chooseMedia, refreshMedia } = workspace;
  const state = useAtomValue(() => library.view);
  const { loadFolder } = library;
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
          disabled={state().refreshing || state().scanActive}
          aria-label="Refresh media"
        >
          <Show
            when={state().refreshing || state().scanActive}
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
      <Show when={state().libraryError || state().scanError}>
        <p role="alert">{state().libraryError || state().scanError}</p>
      </Show>
      <Show
        when={
          state().scanActive ||
          state().importJob?.state === "failed" ||
          Boolean(state().importJob?.errorCode) ||
          Boolean(state().importJob?.validationErrors?.length)
        }
      >
        <Show when={state().scanActive}>
          <div class="library-scan-state" aria-label="Library scan" role="status">
            <LoaderCircle class="spin" size={16} aria-hidden="true" />
            <span>Indexing media…</span>
            <small>
              {state().importJob?.indexed ?? 0} indexed ·{" "}
              {Math.round((state().importJob?.progress ?? 0) * 100)}%
            </small>
            <button
              class="btn btn-ghost btn-xs"
              disabled={state().observationWaiting || state().cancellingImport}
              onClick={() => void library.cancelImport()}
            >
              Cancel
            </button>
          </div>
        </Show>
        <Show when={state().importJob?.state === "failed" || state().importJob?.errorCode}>
          <div
            class="alert alert-error flex flex-wrap items-center justify-between gap-2 [&>span]:min-w-0 [&>span]:wrap-anywhere"
            role="alert"
          >
            <span>
              Media indexing failed
              {state().importJob?.errorCode ? ` (${state().importJob!.errorCode})` : ""}. Refresh to
              try again.
            </span>
            <button
              class="btn btn-ghost btn-xs"
              type="button"
              disabled={state().refreshing || state().scanActive}
              onClick={() => void refreshMedia()}
            >
              Retry
            </button>
          </div>
        </Show>
        <For each={state().importJob?.validationErrors ?? []}>
          {(message) => (
            <p class="field-error" role="alert">
              {message}
            </p>
          )}
        </For>
      </Show>
      <Show when={!selected() && visibleMedia().length === 0 && !state().libraryError}>
        <div class="library-setup" role="region" aria-label="Media library status">
          <p role="status">{state().libraryMessage}</p>
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
          <Show when={state().folders.length}>
            <ul class="folder-list" aria-label="Virtual folders">
              <For each={state().folders}>
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
          <Show when={state().activeFolder}>
            <span class="folder-label">Videos in folder</span>
          </Show>
          <ul class="media-list" aria-label="Media list">
            <For each={visibleMedia()}>
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
                    <MediaThumbnail item={item} api={api} server={workspace.server} />
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
      <Show when={state().nextCursor}>
        <button
          class="btn btn-ghost btn-sm"
          disabled={state().loadingMore}
          onClick={() => void loadFolder(state().activeFolder, state().nextCursor)}
        >
          {state().loadingMore ? "Loading more…" : "Load more"}
        </button>
      </Show>
    </section>
  );
}
