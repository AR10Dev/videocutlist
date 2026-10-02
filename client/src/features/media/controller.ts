import { useAtomValue, useAtomSet } from "@effect/atom-solid";
import { Effect } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createEffect, createSignal, on, onCleanup, type Setter } from "solid-js";
import { apiJson, apiRequest } from "../../api";
import type { components } from "../../generated/api";
import type { Job } from "../../generated/effect-api";
import { readServerAtom, useServerAtom, type ServerState } from "../app/server";

type Media = components["schemas"]["Media"];
type FolderPage = components["schemas"]["FolderPage"];
type LibraryStatus = components["schemas"]["LibraryStatus"];
type ImportJob = Pick<Job, "id" | "state" | "errorCode"> & {
  progress: number;
  indexed?: number;
  validationErrors?: string[];
};

type LibraryPage = { page: FolderPage; library?: LibraryStatus };

const isActiveImport = (job: { state: string } | undefined) =>
  job?.state === "queued" || job?.state === "running";

function generatedMutation<Arg, A, E>(
  server: ServerState,
  atom: Atom.AtomResultFn<Arg, A, E>,
  arg: Arg,
): Effect.Effect<A, E> {
  return Effect.acquireUseRelease(
    Effect.sync(() => server.registry.mount(atom)),
    () => {
      server.registry.set(atom, arg);
      return AtomRegistry.getResult(server.registry, atom, { suspendOnWaiting: true });
    },
    (release) =>
      Effect.sync(() => {
        server.registry.set(atom, Atom.Reset);
        release();
      }),
  );
}

function errorStatus(error: unknown, seen = new Set<object>()): number | undefined {
  if (!error || typeof error !== "object" || seen.has(error)) return;
  seen.add(error);
  if ("status" in error && typeof error.status === "number") return error.status;
  for (const nested of [
    "cause" in error ? error.cause : undefined,
    "reason" in error ? error.reason : undefined,
    "response" in error ? error.response : undefined,
  ]) {
    const status = errorStatus(nested, seen);
    if (status !== undefined) return status;
  }
}

function uncertainRequest(error: unknown): boolean {
  const status = errorStatus(error);
  return status === undefined || status === 0 || status >= 500;
}

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
  const [jobId, setJobId] = createSignal<string>();
  const [observationPending, setObservationPending] = createSignal(false);
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

  const scan = useServerAtom<Job>(() => {
    const id = jobId();
    return id ? server.observeJob(id) : Atom.make(AsyncResult.initial<Job, Error>());
  });
  const importJob = (): ImportJob | undefined => {
    const job = scan.value();
    if (!job || job.id !== jobId()) return;
    const indexed = job.indexed;
    const validationErrors = job.validationErrors;
    return {
      id: job.id,
      state: job.state,
      progress: job.progress ?? 0,
      indexed: typeof indexed === "number" ? indexed : undefined,
      errorCode: job.errorCode,
      validationErrors:
        Array.isArray(validationErrors) &&
        validationErrors.every((error) => typeof error === "string")
          ? validationErrors
          : undefined,
    };
  };
  const scanActive = () => observationPending() || isActiveImport(importJob());
  createEffect(() => {
    const job = scan.value();
    if (job && job.id === jobId()) {
      setObservationPending(false);
      if (!isActiveImport(job)) server.refreshMedia();
    }
  });
  createEffect(() => {
    if (jobId() && scan.error()) setObservationPending(false);
  });

  let uncertainRefreshKey: string | undefined;
  const refreshCommand = runtime.fn((key: string) => {
    const mutation = server.generatedApi?.mutation("default", "refreshMedia");
    if (!mutation) return Effect.fail(new Error("Generated media API is not configured."));
    return generatedMutation(server, mutation, {
      headers: { "Idempotency-Key": key },
    }).pipe(
      Effect.mapError((error) => new Error("Media refresh failed.", { cause: error })),
      Effect.tap((job) =>
        Effect.sync(() => {
          uncertainRefreshKey = undefined;
          setObservationPending(true);
          setJobId(job.id);
          setPendingCursor(undefined);
          setActiveFolder(undefined);
          server.refreshMedia();
        }),
      ),
      Effect.map((job) => ({ status: 202, job })),
    );
  });
  const refreshResult = useAtomValue(() => refreshCommand);
  const startRefresh = useAtomSet(() => refreshCommand, { mode: "promise" });
  const refreshing = () => refreshResult().waiting;
  const cancelCommand = runtime.fn((id: string) => {
    const mutation = server.generatedApi?.mutation("default", "cancelJob");
    if (!mutation) return Effect.fail(new Error("Generated job API is not configured."));
    return generatedMutation(server, mutation, { params: { jobId: id } }).pipe(
      Effect.mapError(() => new Error("Scan could not be cancelled. Try again.")),
    );
  });
  const cancelResult = useAtomValue(() => cancelCommand);
  const startCancel = useAtomSet(() => cancelCommand, { mode: "promise" });
  const cancellingImport = () => observationPending() || cancelResult().waiting;
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
    const key = uncertainRefreshKey ?? globalThis.crypto.randomUUID();
    try {
      await startRefresh(key);
      uncertainRefreshKey = undefined;
    } catch (error) {
      uncertainRefreshKey = uncertainRequest(error) ? key : undefined;
      const status = errorStatus(error);
      if (status === 403) setStatus("You are not allowed to refresh media.");
      else if (status === 429)
        setStatus("Media refresh is already in progress. Try again shortly.");
      else setStatus("Media refresh failed. Try again.");
      return;
    }
    const requestedRevision = registry.get(server.mediaRevision);
    try {
      const refreshed = await Effect.runPromise(
        readServerAtom(server, pageFamily(JSON.stringify([null, null, requestedRevision]))),
      );
      if (
        requestedRevision === registry.get(server.mediaRevision) &&
        activeFolder() === undefined
      ) {
        if (refreshed.library) setLibraryStatus(refreshed.library);
        setFolders(refreshed.page.folders);
        setMedia(refreshed.page.items);
        setNextCursor(refreshed.page.nextCursor ?? undefined);
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
    server.setJobLocallyCancelled(job.id, true);
    try {
      await startCancel(job.id);
    } catch (error) {
      server.setJobLocallyCancelled(job.id, false);
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
