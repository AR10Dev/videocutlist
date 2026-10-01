import { RegistryContext, RegistryProvider } from "@effect/atom-solid";
import {
  createComponent,
  createRoot,
  createSignal,
  untrack,
  useContext,
  type Accessor,
} from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import { createServerState } from "../src/features/app/server";
import { createLibraryController } from "../src/features/media/controller";
import type { components } from "../src/generated/api";

type LibrarySurface = {
  media: Accessor<components["schemas"]["Media"][]>;
  activeFolder: Accessor<string | undefined>;
  nextCursor: Accessor<string | undefined>;
  loadingMore: () => boolean;
  loadFolder: (folderId?: string, cursor?: string) => void;
  refreshMedia: () => Promise<void>;
};

const item = (name: string): components["schemas"]["Media"] => ({
  id: `m_${name.padEnd(43, "a")}`,
  name,
  durationMs: 1000,
  sizeBytes: 100,
  container: "mp4",
  streams: {},
  etag: "v1",
});

const page = (names: string[], nextCursor?: string) =>
  Response.json({
    folders: [
      { id: "folder-a", label: "Folder A" },
      { id: "folder-b", label: "Folder B" },
    ],
    items: names.map(item),
    nextCursor,
  });

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withLibrary(
  request: ApiClient["request"],
  exercise: (library: LibrarySurface) => Promise<void>,
) {
  const api: ApiClient = {
    url: (path) => path,
    request,
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      createComponent(RegistryProvider, {
        get children() {
          untrack(() => {
            const registry = useContext(RegistryContext);
            const [, setStatus] = createSignal("");
            const library = createLibraryController(createServerState(api, registry), setStatus);
            queueMicrotask(() => {
              void exercise(library).then(
                () => {
                  dispose();
                  resolve();
                },
                (error: unknown) => {
                  dispose();
                  reject(error);
                },
              );
            });
          });
          return null;
        },
      });
    });
  });
}

describe("library controller", () => {
  it("does not show a previous folder when its request completes after navigation", async () => {
    const olderFolder = deferredResponse();
    let folderRequested!: () => void;
    const started = new Promise<void>((resolve) => {
      folderRequested = resolve;
    });
    await withLibrary(
      (path) => {
        if (path === "media/tree?folderId=folder-a") {
          folderRequested();
          return olderFolder.promise;
        }
        if (path === "media/tree?folderId=folder-b")
          return Promise.resolve(page(["folder-b-video"]));
        if (path === "media/status")
          return Promise.resolve(Response.json({ state: "ready", message: "Ready" }));
        return Promise.resolve(page(["root-video"]));
      },
      async (library) => {
        await vi.waitFor(() =>
          expect(library.media().map((media) => media.name)).toEqual(["root-video"]),
        );
        library.loadFolder("folder-a");
        await started;
        library.loadFolder("folder-b");
        await vi.waitFor(() =>
          expect(library.media().map((media) => media.name)).toEqual(["folder-b-video"]),
        );
        olderFolder.resolve(page(["wrong-folder-video"]));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(library.activeFolder()).toBe("folder-b");
        expect(library.media().map((media) => media.name)).toEqual(["folder-b-video"]);
      },
    );
  });

  it("does not append an old cursor page after a library refresh", async () => {
    const oldCursor = deferredResponse();
    let refreshed = false;
    let cursorRequested!: () => void;
    const started = new Promise<void>((resolve) => {
      cursorRequested = resolve;
    });
    await withLibrary(
      (path) => {
        if (path === "media/tree?cursor=old-page") {
          cursorRequested();
          return oldCursor.promise;
        }
        if (path === "media/refresh") {
          refreshed = true;
          return Promise.resolve(Response.json({}));
        }
        if (path === "media/status")
          return Promise.resolve(Response.json({ state: "ready", message: "Ready" }));
        return Promise.resolve(
          refreshed ? page(["refreshed-video"]) : page(["old-video"], "old-page"),
        );
      },
      async (library) => {
        await vi.waitFor(() => expect(library.nextCursor()).toBe("old-page"));
        library.loadFolder(undefined, "old-page");
        await vi.waitFor(() => expect(library.loadingMore()).toBe(true));
        await started;
        await library.refreshMedia();
        await vi.waitFor(() =>
          expect(library.media().map((media) => media.name)).toEqual(["refreshed-video"]),
        );
        oldCursor.resolve(page(["old-cursor-video"]));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(library.media().map((media) => media.name)).toEqual(["refreshed-video"]);
        expect(library.nextCursor()).toBeUndefined();
      },
    );
  });
});
