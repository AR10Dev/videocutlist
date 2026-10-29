import { isActiveState } from "../queue/jobState";
import { Cause, Effect, Option, Stream } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { Job, LibraryStatus } from "../../generated/effect-api";
import { apiErrorCode, apiErrorStatus, uncertainCommandFailure } from "../../api";
import { readServerAtom, runServerMutation, type ServerState } from "../../app/server";
import type { WorkspaceIdentity } from "../../app/workspaceIdentity";

type Navigation = {
  folderId: string | undefined;
  revision: number;
  pendingCursor: string | undefined;
  loadedCursors: string[];
};
type ScanIdentity = { id: string | undefined; completed: boolean };
type ImportJob = Pick<Job, "id" | "state" | "errorCode"> & {
  progress: number;
  indexed?: number;
  validationErrors?: string[];
};

function importJob(job: Job | undefined): ImportJob | undefined {
  if (!job) return;
  return {
    id: job.id,
    state: job.state,
    errorCode: job.errorCode,
    progress: job.progress ?? 0,
    indexed: typeof job.indexed === "number" ? job.indexed : undefined,
    validationErrors:
      Array.isArray(job.validationErrors) &&
      job.validationErrors.every((error) => typeof error === "string")
        ? job.validationErrors
        : undefined,
  };
}

const isActiveImport = (job: Job | undefined) => isActiveState(job?.state);
const value = <A, E>(result: AsyncResult.AsyncResult<A, E>) =>
  Option.getOrUndefined(AsyncResult.value(result));
const errorMessage = <A, E>(result: AsyncResult.AsyncResult<A, E>) => {
  if (!AsyncResult.isFailure(result) || Cause.hasInterrupts(result.cause)) return "";
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : "Request could not be completed.";
};

function libraryMessage(current: LibraryStatus | undefined) {
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
}

export function createLibraryController(
  server: ServerState,
  workspaceIdentity: Atom.Writable<WorkspaceIdentity>,
) {
  const { registry, runtime } = server;
  const navigation = Atom.keepAlive(
    Atom.make<Navigation>({
      folderId: undefined,
      revision: registry.get(server.mediaRevision),
      pendingCursor: undefined,
      loadedCursors: [],
    }),
  );
  const scanIdentity = Atom.keepAlive(Atom.make<ScanIdentity>({ id: undefined, completed: false }));
  const uncertainRefreshKey = Atom.keepAlive(Atom.make<string | undefined>(undefined));
  const notice = (status: string) =>
    registry.update(workspaceIdentity, (state) => ({ ...state, status }));
  const firstPage = Atom.make((get) => {
    const { folderId } = get(navigation);
    return get(server.mediaTree(folderId, undefined, get(server.mediaRevision)));
  });
  const libraryStatus = Atom.keepAlive(
    Atom.make((get) => get(server.mediaLibraryStatus(get(server.mediaRevision)))),
  );
  const scan = Atom.make((get) => {
    const { id } = get(scanIdentity);
    return id ? get(server.observeJob(id)) : AsyncResult.initial<Job, Error>();
  });
  // Keep only cursor identities here; canonical pages remain in the generated resource graph.
  const pages = Atom.keepAlive(
    Atom.make((get) => {
      const current = get(navigation);
      const revision = get(server.mediaRevision);
      const initial = value(get(firstPage));
      const more =
        current.revision === revision
          ? current.loadedCursors.map((cursor) =>
              value(get(server.mediaTree(current.folderId, cursor, revision))),
            )
          : [];
      const items = [initial, ...more].flatMap((page) => page?.items ?? []);
      return {
        media: [...new Map(items.map((item) => [item.id, item])).values()],
        folders: initial?.folders ?? [],
        nextCursor: (more.at(-1) ?? initial)?.nextCursor ?? undefined,
      };
    }),
  );
  const observationWaiting = Atom.make((get) =>
    Boolean(get(scanIdentity).id && !value(get(scan)) && !AsyncResult.isFailure(get(scan))),
  );
  const scanActive = Atom.make(
    (get) => get(observationWaiting) || isActiveImport(value(get(scan))),
  );

  const loadMoreCommand = Atom.keepAlive(
    runtime.fn((request: Navigation & { pendingCursor: string }) =>
      Effect.gen(function* () {
        const resource = server.mediaTree(
          request.folderId,
          request.pendingCursor,
          request.revision,
        );
        const previous = registry.get(resource);
        if (AsyncResult.isFailure(previous)) {
          yield* Effect.acquireUseRelease(
            Effect.sync(() => registry.mount(resource)),
            () => {
              registry.refresh(resource);
              // SWR forwards refresh asynchronously; do not consume its previous failure.
              return AtomRegistry.toStream(registry, resource).pipe(
                Stream.filter((result) => result !== previous),
                Stream.take(1),
                Stream.runDrain,
                Effect.andThen(readServerAtom(server, resource)),
              );
            },
            (release) => Effect.sync(release),
          );
        } else yield* readServerAtom(server, resource);
        registry.update(navigation, (current) =>
          current.folderId === request.folderId &&
          current.revision === request.revision &&
          registry.get(server.mediaRevision) === request.revision
            ? {
                ...current,
                loadedCursors: current.loadedCursors.includes(request.pendingCursor)
                  ? current.loadedCursors
                  : [...current.loadedCursors, request.pendingCursor],
              }
            : current,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.fail(
                new Error("Media could not be loaded. Try again.", { cause: Cause.squash(cause) }),
              ),
        ),
        Effect.ensuring(
          Effect.sync(() =>
            registry.update(navigation, (current) =>
              current.folderId === request.folderId &&
              current.revision === request.revision &&
              current.pendingCursor === request.pendingCursor
                ? { ...current, pendingCursor: undefined }
                : current,
            ),
          ),
        ),
      ),
    ),
  );
  const refreshCommand = Atom.keepAlive(
    runtime.fn(() =>
      Effect.gen(function* () {
        const key = registry.get(uncertainRefreshKey) ?? globalThis.crypto.randomUUID();
        const job = yield* runServerMutation(
          registry,
          server.generatedApi.mutation("default", "refreshMedia"),
          { headers: { "Idempotency-Key": key } },
        ).pipe(
          Effect.catchCause((cause): Effect.Effect<never, unknown> => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
            const error = Cause.squash(cause);
            registry.set(
              uncertainRefreshKey,
              uncertainCommandFailure(error, [
                "origin_forbidden",
                "library_busy",
                "invalid_idempotency_key",
                "idempotency_conflict",
              ])
                ? key
                : undefined,
            );
            const code = apiErrorCode(error);
            const status = apiErrorStatus(error);
            notice(
              status === 403 || code === "origin_forbidden"
                ? "You are not allowed to refresh media."
                : status === 429 || code === "library_busy"
                  ? "Media refresh is already in progress. Try again shortly."
                  : "Media refresh failed. Try again.",
            );
            return Effect.fail(new Error("Media refresh failed.", { cause: error }));
          }),
        );
        registry.set(uncertainRefreshKey, undefined);
        registry.set(scanIdentity, { id: job.id, completed: false });
        resetNavigation(undefined);
        server.refreshMedia();
        notice("Choose media to begin.");
      }),
    ),
  );
  const cancelCommand = Atom.keepAlive(
    runtime.fn((id: string) =>
      Effect.gen(function* () {
        server.setJobLocallyCancelled(id, true);
        yield* runServerMutation(registry, server.generatedApi.mutation("default", "cancelJob"), {
          params: { jobId: id },
        }).pipe(
          Effect.catchCause((cause): Effect.Effect<never, unknown> => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
            server.setJobLocallyCancelled(id, false);
            return Effect.fail(
              new Error("Scan could not be cancelled. Try again.", { cause: Cause.squash(cause) }),
            );
          }),
          // Interrupting the client request does not prove that the Go scan was cancelled.
          Effect.onInterrupt(() => Effect.sync(() => server.setJobLocallyCancelled(id, false))),
        );
      }),
    ),
  );
  function resetNavigation(folderId: string | undefined) {
    registry.set(loadMoreCommand, Atom.Interrupt);
    registry.set(loadMoreCommand, Atom.Reset);
    registry.set(navigation, {
      folderId,
      revision: registry.get(server.mediaRevision),
      pendingCursor: undefined,
      loadedCursors: [],
    });
  }

  const navigateCommand = runtime.fn(
    ({ folderId, cursor }: { folderId?: string; cursor?: string }) =>
      Effect.sync(() => {
        if (!registry.get(cancelCommand).waiting) registry.set(cancelCommand, Atom.Reset);
        if (cursor) {
          const current = registry.get(navigation);
          if (
            registry.get(loadMoreCommand).waiting ||
            current.folderId !== folderId ||
            registry.get(pages).nextCursor !== cursor ||
            current.loadedCursors.includes(cursor)
          )
            return;
          const request = { ...current, pendingCursor: cursor };
          registry.set(navigation, request);
          registry.set(loadMoreCommand, request);
          return;
        }
        notice("Loading media…");
        resetNavigation(folderId);
      }),
    { concurrent: true },
  );

  const view = Atom.make((get) => ({
    ...get(pages),
    activeFolder: get(navigation).folderId,
    loadingMore: get(loadMoreCommand).waiting,
    refreshing: get(refreshCommand).waiting,
    cancellingImport: get(cancelCommand).waiting,
    libraryStatus: value(get(libraryStatus)),
    libraryMessage: libraryMessage(value(get(libraryStatus))),
    libraryError:
      errorMessage(get(cancelCommand)) ||
      errorMessage(get(libraryStatus)) ||
      errorMessage(get(loadMoreCommand)) ||
      errorMessage(get(firstPage)),
    importJob: importJob(value(get(scan))),
    scanActive: get(scanActive),
    observationWaiting: get(observationWaiting),
    scanError: errorMessage(get(scan)),
  }));

  // Native subscriptions belong to the workspace registry, not a Solid component/root.
  // keepAlive preserves navigation, results and loaded-page ownership across view unsubscribe.
  const handleScan = (result: AsyncResult.AsyncResult<Job, Error>) => {
    const current = registry.get(scanIdentity);
    if (
      AsyncResult.isSuccess(result) &&
      result.value.id === current.id &&
      !current.completed &&
      !isActiveImport(result.value)
    ) {
      registry.set(scanIdentity, { ...current, completed: true });
      server.refreshMedia();
    }
  };
  const observation = Atom.keepAlive(
    Atom.make((get) => {
      get.subscribe(server.mediaRevision, () => resetNavigation(registry.get(navigation).folderId));
      get.subscribe(
        firstPage,
        (result) => {
          if (result.waiting) return;
          const error = errorMessage(result);
          if (error) notice(error);
          else if (
            AsyncResult.isSuccess(result) &&
            !registry.get(navigation).folderId &&
            registry.get(workspaceIdentity).status === "Loading media…"
          )
            notice("Choose media to begin.");
        },
        { immediate: true },
      );
      get.subscribe(scanIdentity, () => handleScan(registry.get(scan)));
      get.subscribe(scan, handleScan);
    }),
  );
  registry.get(observation);
  registry.get(pages);
  registry.get(libraryStatus);

  return {
    navigation,
    scanIdentity,
    uncertainRefreshKey,
    view,
    refreshCommand,
    cancelCommand,
    loadMoreCommand,
    loadFolder(folderId?: string, cursor?: string) {
      registry.set(navigateCommand, { folderId, cursor });
    },
    refreshMedia() {
      if (registry.get(refreshCommand).waiting || registry.get(scanActive)) return;
      registry.set(cancelCommand, Atom.Reset);
      registry.set(refreshCommand, undefined);
    },
    cancelImport() {
      const job = value(registry.get(scan));
      if (!job || !isActiveImport(job) || registry.get(cancelCommand).waiting) return;
      registry.set(cancelCommand, job.id);
    },
  };
}
