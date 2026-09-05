import { createEffect, createSignal, type Setter } from "solid-js";
import { useQuery, type QueryClient } from "@tanstack/solid-query";
import type { ApiClient } from "../../api";
import type { components } from "../../generated/api";

type Media = components["schemas"]["Media"];
type FolderPage = components["schemas"]["FolderPage"];
type LibraryStatus = components["schemas"]["LibraryStatus"];
type ImportJob = {
  id: string;
  state: string;
  progress: number;
  indexed: number;
  errorCode?: string;
  validationErrors?: string[];
};

export function createLibraryController(
  api: ApiClient,
  queryClient: QueryClient,
  setStatus: Setter<string>,
) {
  const [media, setMedia] = createSignal<Media[]>([]);
  const [nextCursor, setNextCursor] = createSignal<string>();
  const [folders, setFolders] = createSignal<{ id: string; label: string }[]>([]);
  const [activeFolder, setActiveFolder] = createSignal<string>();
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);
  const [libraryStatus, setLibraryStatus] = createSignal<LibraryStatus>();
  const [libraryError, setLibraryError] = createSignal("");
  const [importJob, setImportJob] = createSignal<ImportJob>();
  const [cancellingImport, setCancellingImport] = createSignal(false);
  const scanActive = () => ["queued", "running"].includes(importJob()?.state ?? "");
  const scanQuery = useQuery(() => ({
    queryKey: ["media-import", importJob()?.id],
    enabled: Boolean(importJob()?.id) && scanActive(),
    queryFn: async ({ signal }) => {
      const response = await api.request(`media/import/${encodeURIComponent(importJob()!.id)}`, {
        signal,
      });
      if (!response.ok) throw new Error("Scan progress could not be loaded. Refresh to retry.");
      return (await response.json()) as ImportJob;
    },
    refetchInterval: 500,
  }));
  createEffect(() => {
    const next = scanQuery.data;
    if (!next || next.id !== importJob()?.id) return;
    setImportJob(next);
    if (!["queued", "running"].includes(next.state)) void loadFolder();
  });
  const cancelImport = async () => {
    const job = importJob();
    if (!job || !scanActive() || cancellingImport()) return;
    setCancellingImport(true);
    try {
      const response = await api.request(`media/import/${encodeURIComponent(job.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Scan could not be cancelled. Try again.");
      await queryClient.invalidateQueries({ queryKey: ["media-import", job.id] });
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "Scan cancellation failed.");
    } finally {
      setCancellingImport(false);
    }
  };
  let folderRequestVersion = 0;

  const loadFolder = async (folderId?: string, cursor?: string) => {
    const request = ++folderRequestVersion;
    setLibraryError("");
    const params = new URLSearchParams();
    if (folderId) params.set("folderId", folderId);
    if (cursor) params.set("cursor", cursor);
    const query = params.toString() ? `?${params}` : "";
    if (cursor) setLoadingMore(true);
    else setStatus("Loading media…");
    try {
      const result = await queryClient.fetchQuery({
        queryKey: ["media", "tree", folderId ?? null, cursor ?? null],
        queryFn: async ({ signal }) => {
          const response = await api.request(`media/tree${query}`, { signal });
          if (!response.ok) throw new Error(`Media request failed (${response.status}).`);
          const page = (await response.json()) as FolderPage;
          if (folderId || cursor) return { page };
          const libraryResponse = await api.request("media/status", { signal });
          return {
            page,
            library: libraryResponse.ok
              ? ((await libraryResponse.json()) as LibraryStatus)
              : undefined,
          };
        },
      });
      if (request !== folderRequestVersion) return;
      if (result.library) setLibraryStatus(result.library);
      setFolders(result.page.folders);
      setMedia(cursor ? [...media(), ...result.page.items] : result.page.items);
      setNextCursor(result.page.nextCursor ?? undefined);
      setActiveFolder(folderId);
      if (!folderId && !cursor) setStatus("Choose media to begin.");
    } catch (error) {
      if (request === folderRequestVersion) {
        const message = error instanceof Error ? error.message : "Media request failed.";
        setStatus(message);
        setLibraryError(message);
      }
    } finally {
      if (request === folderRequestVersion) setLoadingMore(false);
    }
  };
  createEffect(() => void loadFolder());

  const libraryMessage = () => {
    const current = libraryStatus();
    if (!current) return "Checking the server media library… Refresh to check again.";
    const action =
      current.state === "unconfigured"
        ? "Configure the server media root, then Refresh."
        : current.state === "scanning"
          ? "Wait for indexing to finish, then Refresh."
          : current.state === "ready_empty"
            ? "Mount supported media, then Refresh to index it."
            : current.state === "failed"
              ? "Check the server configuration, then Refresh to retry."
              : "Choose a video from the indexed library to begin.";
    return `${current.message} ${action}`;
  };

  const refreshMedia = async () => {
    folderRequestVersion++;
    setRefreshing(true);
    setActiveFolder(undefined);
    setNextCursor(undefined);
    setFolders([]);
    try {
      await queryClient.invalidateQueries({ queryKey: ["media"] });
      const response = await api.request("media/refresh", {
        method: "POST",
        signal: new AbortController().signal,
      });
      if (response.status === 403) setStatus("You are not allowed to refresh media.");
      else if (response.status === 429)
        setStatus("Media refresh is already in progress. Try again shortly.");
      else if (!response.ok) setStatus("Media refresh failed. Try again.");
      else {
        const job = (await response.json().catch(() => undefined)) as ImportJob | undefined;
        if (job?.id) setImportJob(job);
        await loadFolder();
      }
    } catch {
      setStatus("Media refresh failed. Try again.");
    } finally {
      setRefreshing(false);
    }
  };

  return {
    media,
    setMedia,
    nextCursor,
    setNextCursor,
    folders,
    setFolders,
    activeFolder,
    setActiveFolder,
    loadingMore,
    setLoadingMore,
    refreshing,
    setRefreshing,
    libraryStatus,
    setLibraryStatus,
    loadFolder,
    libraryMessage,
    libraryError,
    importJob,
    scanActive,
    cancellingImport,
    cancelImport,
    scanError: () => scanQuery.error?.message,
    refreshMedia,
  };
}
