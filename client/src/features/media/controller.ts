import { useAtomValue, useAtomSet } from "@effect/atom-solid";
import { Effect } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { createEffect, createSignal, on, onCleanup, type Setter } from "solid-js";
import { apiJson, apiRequest } from "../../api";
import type { components } from "../../generated/api";
import { pollAtom, readServerAtom, useServerAtom, type ServerState } from "../app/server";

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
type LibraryPage = { page: FolderPage; library?: LibraryStatus };

const isActiveImport = (job: ImportJob | undefined) =>
  job?.state === "queued" || job?.state === "running";

export function createLibraryController(server: ServerState, setStatus: Setter<string>) {
  const { api, registry, runtime } = server;
  const revision = useAtomValue(() => server.mediaRevision);
  // JSON tuples are stable primitive family keys; a revision never reuses pre-refresh pages.
  const pageFamily = Atom.family((key: string) => {
    const [folderId, cursor] = JSON.parse(key) as [string | null, string | null, number];
    const params = new URLSearchParams();
    if (folderId) params.set("folderId", folderId);
    if (cursor) params.set("cursor", cursor);
    const path = `media/tree${params.size ? `?${params}` : ""}`;
    return runtime
      .atom(
        Effect.gen(function* () {
          const page = yield* apiJson<FolderPage>(api, path);
          if (folderId || cursor) return { page };
          const response = yield* apiRequest(api, "media/status");
          const library = response.ok
            ? yield* Effect.tryPromise({
                try: () => response.json() as Promise<LibraryStatus>,
                catch: (error) =>
                  error instanceof Error ? error : new Error("Media status could not be loaded."),
              })
            : undefined;
          return { page, library };
        }),
      )
      .pipe(
        Atom.setIdleTTL("5 minutes"),
        Atom.swr({ staleTime: 0, revalidateOnMount: true, revalidateOnFocus: true }),
      );
  });
  const pageAtom = (folderId?: string, cursor?: string) =>
    pageFamily(JSON.stringify([folderId ?? null, cursor ?? null, revision()]));

  const [media, setMedia] = createSignal<Media[]>([]);
  const [nextCursor, setNextCursor] = createSignal<string>();
  const [folders, setFolders] = createSignal<{ id: string; label: string }[]>([]);
  const [activeFolder, setActiveFolder] = createSignal<string>();
  const [pendingCursor, setPendingCursor] = createSignal<string>();
  const [libraryStatus, setLibraryStatus] = createSignal<LibraryStatus>();
  const [actionError, setActionError] = createSignal("");
  const [startedJob, setStartedJob] = createSignal<ImportJob>();
  const [jobId, setJobId] = createSignal<string>();
  createEffect(
    on(
      revision,
      () => {
        setPendingCursor(undefined);
        setMedia([]);
        setNextCursor(undefined);
        setFolders([]);
      },
      { defer: true },
    ),
  );

  const firstPage = useServerAtom<LibraryPage>(() => pageAtom(activeFolder()));
  const morePage = useServerAtom<LibraryPage>(() => pageAtom(activeFolder(), pendingCursor()));
  createEffect(() => {
    const result = firstPage.result();
    if (result.waiting || !AsyncResult.isSuccess(result)) return;
    if (result.value.library) setLibraryStatus(result.value.library);
    setFolders(result.value.page.folders);
    setMedia(result.value.page.items);
    setNextCursor(result.value.page.nextCursor ?? undefined);
    if (!activeFolder()) setStatus("Choose media to begin.");
  });
  createEffect(() => {
    const cursor = pendingCursor();
    if (!cursor) return;
    const result = morePage.result();
    if (result.waiting || !AsyncResult.isSuccess(result)) return;
    setFolders(result.value.page.folders);
    setMedia((items) => [...items, ...result.value.page.items]);
    setNextCursor(result.value.page.nextCursor ?? undefined);
    setPendingCursor(undefined);
  });
  createEffect(() => {
    const error = pendingCursor() ? morePage.error() : firstPage.error();
    if (error) setStatus(error.message);
  });

  const jobFamily = Atom.family((id: string) =>
    pollAtom(
      runtime,
      apiJson<ImportJob>(api, `media/import/${encodeURIComponent(id)}`),
      isActiveImport,
      500,
    ),
  );
  const emptyJob = Atom.make(AsyncResult.initial<ImportJob, Error>());
  const scan = useServerAtom<ImportJob>(() =>
    jobId() && isActiveImport(startedJob()) ? jobFamily(jobId()!) : emptyJob,
  );
  const importJob = () => {
    const observed = scan.value();
    return observed?.id === jobId() ? observed : startedJob();
  };
  const scanActive = () => isActiveImport(importJob());
  createEffect(() => {
    const job = scan.value();
    if (job && job.id === jobId() && !isActiveImport(job)) {
      setStartedJob(job);
      server.refreshMedia();
    }
  });

  const refreshCommand = runtime.fn(() =>
    Effect.gen(function* () {
      const response = yield* apiRequest(api, "media/refresh", { method: "POST" });
      if (!response.ok) return { status: response.status };
      const job = yield* Effect.tryPromise({
        try: () => response.json().catch(() => undefined) as Promise<ImportJob | undefined>,
        catch: (error) => (error instanceof Error ? error : new Error("Media refresh failed.")),
      });
      yield* Effect.sync(() => {
        if (job?.id) {
          setStartedJob(job);
          setJobId(job.id);
        }
        setPendingCursor(undefined);
        setActiveFolder(undefined);
        server.refreshMedia();
      });
      const requestedRevision = registry.get(server.mediaRevision);
      const refreshed = yield* readServerAtom(
        server,
        pageFamily(JSON.stringify([null, null, requestedRevision])),
      );
      return { status: response.status, requestedRevision, refreshed };
    }),
  );
  const refreshResult = useAtomValue(() => refreshCommand);
  const startRefresh = useAtomSet(() => refreshCommand, { mode: "promise" });
  const refreshing = () => refreshResult().waiting;
  const cancelCommand = runtime.fn((id: string) =>
    Effect.gen(function* () {
      const response = yield* apiRequest(api, `media/import/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Scan could not be cancelled. Try again.");
    }),
  );
  const cancelResult = useAtomValue(() => cancelCommand);
  const startCancel = useAtomSet(() => cancelCommand, { mode: "promise" });
  const cancellingImport = () => cancelResult().waiting;
  onCleanup(() => {
    registry.set(refreshCommand, Atom.Interrupt);
    registry.set(cancelCommand, Atom.Interrupt);
  });

  const loadFolder = (folderId?: string, cursor?: string) => {
    setActionError("");
    if (cursor) {
      const page = pageAtom(folderId, cursor);
      if (AsyncResult.isFailure(registry.get(page))) registry.refresh(page);
      if (pendingCursor() !== cursor) setPendingCursor(cursor);
      return;
    }
    setPendingCursor(undefined);
    setActiveFolder(folderId);
    const page = pageAtom(folderId);
    const current = registry.get(page);
    if (AsyncResult.isFailure(current)) registry.refresh(page);
    if (AsyncResult.isSuccess(current) && !current.waiting) {
      setFolders(current.value.page.folders);
      setMedia(current.value.page.items);
      setNextCursor(current.value.page.nextCursor ?? undefined);
    } else {
      setMedia([]);
      setNextCursor(undefined);
      setStatus("Loading media…");
    }
  };

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
    if (refreshing() || scanActive()) return;
    setActionError("");
    try {
      const result = await startRefresh();
      if (result.status === 403) setStatus("You are not allowed to refresh media.");
      else if (result.status === 429)
        setStatus("Media refresh is already in progress. Try again shortly.");
      else if (result.status < 200 || result.status >= 300)
        setStatus("Media refresh failed. Try again.");
      else if (
        result.refreshed &&
        result.requestedRevision === registry.get(server.mediaRevision) &&
        activeFolder() === undefined
      ) {
        if (result.refreshed.library) setLibraryStatus(result.refreshed.library);
        setFolders(result.refreshed.page.folders);
        setMedia(result.refreshed.page.items);
        setNextCursor(result.refreshed.page.nextCursor ?? undefined);
        setStatus("Choose media to begin.");
      }
    } catch {
      setStatus("Media refresh failed. Try again.");
    }
  };

  const cancelImport = async () => {
    const job = importJob();
    if (!job || !scanActive() || cancellingImport()) return;
    setActionError("");
    try {
      await startCancel(job.id);
      registry.refresh(jobFamily(job.id));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Scan cancellation failed.");
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
    loadingMore: () => Boolean(pendingCursor() && morePage.waiting()),
    refreshing,
    libraryStatus,
    setLibraryStatus,
    loadFolder,
    libraryMessage,
    libraryError: () =>
      actionError() || (pendingCursor() ? morePage.error() : firstPage.error())?.message || "",
    importJob,
    scanActive,
    cancellingImport,
    cancelImport,
    scanError: () => scan.error()?.message,
    refreshMedia,
  };
}
