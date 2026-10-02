import type * as EffectApiTypes from "../../generated/effect-api";
import { useAtomValue, useAtomSet } from "@effect/atom-solid";
import { Effect } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import {
  createEffect,
  createRoot,
  createSignal,
  on,
  onCleanup,
  type Accessor,
  type Setter,
} from "solid-js";
import type { Job } from "../../generated/effect-api";
import { apiErrorCode, apiErrorStatus, uncertainCommandFailure } from "../../api";
import { useServerAtom, type ServerState } from "../app/server";

type Media = EffectApiTypes.Media;
type PageResult = import("../../generated/effect-api").FolderPage;
type ImportJob = Pick<Job, "id" | "state" | "errorCode"> & {
  progress: number;
  indexed?: number;
  validationErrors?: string[];
};

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

export function createLibraryController(server: ServerState, setStatus: Setter<string>) {
  const { registry, runtime } = server;
  const revision = useAtomValue(() => server.mediaRevision);
  const [activeFolder, setActiveFolder] = createSignal<string>();
  const [pendingCursor, setPendingCursor] = createSignal<string>();
  const [loadedCursors, setLoadedCursors] = createSignal<string[]>([]);
  const [actionError, setActionError] = createSignal("");
  const [jobId, setJobId] = createSignal<string>();
  const [observationPending, setObservationPending] = createSignal(false);
  const firstPage = useServerAtom<PageResult, unknown>(() =>
    server.mediaTree(activeFolder(), undefined, revision()),
  );
  const morePage = useServerAtom<PageResult, unknown>(() =>
    server.mediaTree(activeFolder(), pendingCursor(), revision()),
  );
  const library = useServerAtom<import("../../generated/effect-api").LibraryStatus, unknown>(() =>
    server.mediaLibraryStatus(revision()),
  );
  const pageSubscriptions = new Map<
    string,
    { value: Accessor<AsyncResult.AsyncResult<PageResult, unknown>>; dispose: () => void }
  >();
  const subscribePage = (folderId: string | undefined, cursor: string) => {
    const key = JSON.stringify([folderId ?? null, cursor, revision()]);
    const existing = pageSubscriptions.get(key);
    if (existing) return existing.value;
    const atom = server.mediaTree(folderId, cursor, revision());
    let value!: Accessor<AsyncResult.AsyncResult<PageResult, unknown>>;
    let dispose!: () => void;
    createRoot((rootDispose) => {
      dispose = rootDispose;
      const [result, setResult] = createSignal(registry.get(atom));
      value = result;
      onCleanup(registry.subscribe(atom, setResult, { immediate: true }));
    });
    pageSubscriptions.set(key, { value, dispose });
    return value;
  };
  const disposePages = () => {
    for (const page of pageSubscriptions.values()) page.dispose();
    pageSubscriptions.clear();
  };
  createEffect(
    on(
      revision,
      () => {
        disposePages();
        setLoadedCursors([]);
        setPendingCursor(undefined);
      },
      { defer: true },
    ),
  );
  createEffect(() => {
    activeFolder();
    disposePages();
    setLoadedCursors([]);
    setPendingCursor(undefined);
  });
  createEffect(() => {
    const result = firstPage.result();
    if (result.waiting || !AsyncResult.isSuccess(result)) return;
    if (!activeFolder()) setStatus("Choose media to begin.");
  });
  createEffect(() => {
    const cursor = pendingCursor();
    if (!cursor) return;
    const result = morePage.result();
    if (result.waiting || !AsyncResult.isSuccess(result)) return;
    subscribePage(activeFolder(), cursor);
    setLoadedCursors((cursors) => (cursors.includes(cursor) ? cursors : [...cursors, cursor]));
    setPendingCursor(undefined);
  });
  createEffect(() => {
    const error = pendingCursor() ? morePage.error() : firstPage.error();
    if (error) setStatus(error.message);
  });
  const folders = () => firstPage.value()?.folders ?? [];
  const media = () => {
    const initial = firstPage.value()?.items ?? [];
    // SAFETY: generated FolderPage media items match the OpenAPI components media shape.
    return [
      ...initial,
      ...loadedCursors().flatMap((cursor) => {
        const result = pageSubscriptions
          .get(JSON.stringify([activeFolder() ?? null, cursor, revision()]))
          ?.value();
        return result && AsyncResult.isSuccess(result) ? result.value.items : [];
      }),
    ] as unknown as Media[];
  };
  const nextCursor = () => {
    const cursor = loadedCursors().at(-1);
    if (cursor) {
      const result = pageSubscriptions
        .get(JSON.stringify([activeFolder() ?? null, cursor, revision()]))
        ?.value();
      return result && AsyncResult.isSuccess(result)
        ? (result.value.nextCursor ?? undefined)
        : undefined;
    }
    return firstPage.value()?.nextCursor ?? undefined;
  };
  const libraryStatus = () => library.value();

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
    const mutation = server.generatedApi.mutation("default", "refreshMedia");
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
    );
  });
  const refreshResult = useAtomValue(() => refreshCommand);
  const startRefresh = useAtomSet(() => refreshCommand, { mode: "promise" });
  const refreshing = () => refreshResult().waiting;
  const cancelCommand = runtime.fn((id: string) => {
    const mutation = server.generatedApi.mutation("default", "cancelJob");
    return generatedMutation(server, mutation, { params: { jobId: id } }).pipe(
      Effect.mapError(() => new Error("Scan could not be cancelled. Try again.")),
    );
  });
  const cancelResult = useAtomValue(() => cancelCommand);
  const startCancel = useAtomSet(() => cancelCommand, { mode: "promise" });
  const cancellingImport = () => observationPending() || cancelResult().waiting;
  onCleanup(() => {
    disposePages();
    registry.set(refreshCommand, Atom.Interrupt);
    registry.set(cancelCommand, Atom.Interrupt);
  });

  const loadFolder = (folderId?: string, cursor?: string) => {
    setActionError("");
    if (cursor) {
      const page = server.mediaTree(folderId, cursor, revision());
      if (AsyncResult.isFailure(registry.get(page))) registry.refresh(page);
      if (pendingCursor() !== cursor) setPendingCursor(cursor);
      return;
    }
    setPendingCursor(undefined);
    setActiveFolder(folderId);
    setStatus("Loading media…");
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
      uncertainRefreshKey = uncertainCommandFailure(error, [
        "origin_forbidden",
        "library_busy",
        "invalid_idempotency_key",
        "idempotency_conflict",
      ])
        ? key
        : undefined;
      const code = apiErrorCode(error);
      const status = apiErrorStatus(error);
      if (status === 403 || code === "origin_forbidden")
        setStatus("You are not allowed to refresh media.");
      else if (status === 429 || code === "library_busy")
        setStatus("Media refresh is already in progress. Try again shortly.");
      else setStatus("Media refresh failed. Try again.");
      return;
    }
    if (activeFolder() === undefined) setStatus("Choose media to begin.");
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
    nextCursor,
    folders,
    activeFolder,
    setActiveFolder,
    loadingMore: () => Boolean(pendingCursor() && morePage.waiting()),
    refreshing,
    libraryStatus,
    loadFolder,
    libraryMessage,
    libraryError: () =>
      actionError() ||
      library.error()?.message ||
      (pendingCursor() ? morePage.error() : firstPage.error())?.message ||
      "",
    importJob,
    scanActive,
    cancellingImport,
    cancelImport,
    scanError: () => scan.error()?.message,
    refreshMedia,
  };
}
