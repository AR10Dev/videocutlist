import { useAtomValue } from "@effect/atom-solid";
import { Cause, Effect, Exit, Layer, Option, Schedule, Stream } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as AtomHttpApi from "effect/reactivity/AtomHttpApi";
import { createMemo, type Accessor } from "solid-js";
import {
  ApiFailure,
  createApiClient,
  createNativeHttpClientLayer,
  type ApiClient,
  type ClientConfiguration,
  type NativeMediaApiClient,
} from "../../api";
import { VideoCutListApi } from "../../generated/effect-api";
import type { components } from "../../generated/api";
import {
  Batch as BatchSchema,
  Job as JobSchema,
  type Batch,
  type FolderPage as GeneratedFolderPage,
  type Job,
  type LibraryStatus as GeneratedLibraryStatus,
  type Project,
  type ProjectPage,
} from "../../generated/effect-api";
import { observeSnapshots } from "../queue/jobStream";

type Media = components["schemas"]["Media"];

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

export interface ServerState {
  readonly api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest">;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly runtime: Atom.AtomRuntime<never>;
  readonly generatedApi?: ReturnType<typeof createGeneratedApi>;
  readonly media: (
    id: string,
    revision?: number,
  ) => Atom.Atom<AsyncResult.AsyncResult<Media, Error>>;
  readonly mediaTree: (
    folderId: string | undefined,
    cursor: string | undefined,
    revision: number,
  ) => Atom.Atom<AsyncResult.AsyncResult<GeneratedFolderPage, unknown>>;
  readonly mediaLibraryStatus: (
    revision: number,
  ) => Atom.Atom<AsyncResult.AsyncResult<GeneratedLibraryStatus, unknown>>;
  readonly project: (id: string) => Atom.Atom<AsyncResult.AsyncResult<Project, unknown>>;
  readonly projectPage: (query: {
    limit?: number;
    cursor?: string;
  }) => Atom.Atom<AsyncResult.AsyncResult<ProjectPage, unknown>>;
  readonly observeJob: (
    id: string,
    initial?: Job,
  ) => Atom.Atom<AsyncResult.AsyncResult<Job, Error>>;
  readonly observeBatch: (
    id: string,
    initial?: Batch,
  ) => Atom.Atom<AsyncResult.AsyncResult<Batch, Error>>;
  readonly setJobLocallyCancelled: (id: string, cancelled: boolean) => void;
  readonly setBatchLocallyCancelled: (id: string, cancelled: boolean) => void;
  readonly mediaRevision: Atom.Writable<number>;
  refreshMedia(): void;
}

/** One workspace owns the registry, resource identities and Effect dependency graph. */
function createGeneratedApi(configuration: ClientConfiguration) {
  const api = createApiClient(configuration);
  return AtomHttpApi.Service()("WorkspaceApi", {
    api: VideoCutListApi,
    httpClient: createNativeHttpClientLayer(configuration),
    baseUrl: api.url(""),
  });
}

export function createServerState(
  api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest">,
  registry: AtomRegistry.AtomRegistry,
  configuration?: ClientConfiguration,
) {
  const generatedApi = configuration ? createGeneratedApi(configuration) : undefined;
  const runtime = Atom.runtime(Layer.empty);
  const mediaRevision = Atom.make(0);
  const mountedJobs = new Set<string>();
  const mountedBatches = new Set<string>();
  const locallyCancelledJobs = new Set<string>();
  const locallyCancelledBatches = new Set<string>();
  const jobAtoms = new Map<string, Atom.Atom<AsyncResult.AsyncResult<Job, Error>>>();
  const batchAtoms = new Map<string, Atom.Atom<AsyncResult.AsyncResult<Batch, Error>>>();
  const jobAtom = (id: string, initial?: Job) => {
    if (initial && initial.id !== id) throw new Error("Job snapshot does not match its identity.");
    let atom = jobAtoms.get(id);
    if (!atom) {
      const terminal = initial && ["succeeded", "failed", "cancelled"].includes(initial.state);
      if (terminal) {
        atom = Atom.make(AsyncResult.success(initial));
      } else {
        let latestRevision = initial?.revision ?? 0;
        let terminal = false;
        const isValidSnapshot = (snapshot: Job) =>
          snapshot.id === id && snapshot.revision > latestRevision;
        const isTerminalSnapshot = (snapshot: Job) =>
          isValidSnapshot(snapshot) &&
          ["succeeded", "failed", "cancelled"].includes(snapshot.state);
        atom = runtime.atom<Job, Error>(
          observeSnapshots<Job, Job>(
            api,
            `jobs/${encodeURIComponent(id)}/events`,
            JobSchema,
            isTerminalSnapshot,
          ).pipe(
            Stream.filter((snapshot) => {
              if (!isValidSnapshot(snapshot) || terminal) return false;
              const terminalSnapshot = isTerminalSnapshot(snapshot);
              if (locallyCancelledJobs.has(id) && !terminalSnapshot) return false;
              latestRevision = snapshot.revision;
              terminal = terminalSnapshot;
              return true;
            }),
          ),
          initial ? { initialValue: initial } : undefined,
        );
      }
      jobAtoms.set(id, atom);
    }
    return atom;
  };
  const batchAtom = (id: string, initial?: Batch) => {
    if (initial && initial.batchId !== id)
      throw new Error("Batch snapshot does not match its identity.");
    let atom = batchAtoms.get(id);
    if (!atom) {
      let latestRevisions = new Map(initial?.jobs.map((job) => [job.id, job.revision]) ?? []);
      let terminal = initial ? ["succeeded", "failed", "cancelled"].includes(initial.state) : false;
      const isValidSnapshot = (snapshot: Batch) =>
        snapshot.batchId === id &&
        !snapshot.jobs.some((job) => job.revision < (latestRevisions.get(job.id) ?? 0));
      const isTerminalSnapshot = (snapshot: Batch) =>
        isValidSnapshot(snapshot) && ["succeeded", "failed", "cancelled"].includes(snapshot.state);
      atom = runtime.atom<Batch, Error>(
        observeSnapshots<Batch, Batch>(
          api,
          `batches/${encodeURIComponent(id)}/events`,
          BatchSchema,
          isTerminalSnapshot,
        ).pipe(
          Stream.filter((snapshot) => {
            if (!isValidSnapshot(snapshot) || terminal) return false;
            const terminalSnapshot = isTerminalSnapshot(snapshot);
            if (locallyCancelledBatches.has(id) && !terminalSnapshot) return false;
            latestRevisions = new Map(snapshot.jobs.map((job) => [job.id, job.revision]));
            terminal = terminalSnapshot;
            return true;
          }),
        ),
        initial ? { initialValue: initial } : undefined,
      );
      batchAtoms.set(id, atom);
    }
    return atom;
  };
  const observeJob = (id: string, initial?: Job) => {
    const atom = jobAtom(id, initial);
    if (!mountedJobs.has(id)) {
      mountedJobs.add(id);
      registry.mount(atom);
    }
    return atom;
  };
  const observeBatch = (id: string, initial?: Batch) => {
    const atom = batchAtom(id, initial);
    if (!mountedBatches.has(id)) {
      mountedBatches.add(id);
      registry.mount(atom);
    }
    return atom;
  };
  const project = (id: string) => {
    if (!generatedApi) throw new Error("Generated project API is not configured.");
    return generatedApi.query("default", "getProject", { params: { projectId: id } });
  };
  const projectPage = (query: { limit?: number; cursor?: string }) => {
    if (!generatedApi) throw new Error("Generated project API is not configured.");
    return generatedApi.query("default", "listProjects", { query });
  };
  const mediaTree = Atom.family((key: string) => {
    const [folderId, cursor, revision] = JSON.parse(key) as [string | null, string | null, number];
    if (!generatedApi) throw new Error("Generated media API is not configured.");
    return generatedApi
      .query("default", "browseMediaTree", {
        query: {
          ...(folderId !== null ? { folderId } : {}),
          ...(cursor !== null ? { cursor } : {}),
        },
        reactivityKeys: [`media:${revision}`],
        timeToLive: "5 minutes",
      })
      .pipe(
        Atom.swr({ staleTime: 0, revalidateOnMount: true, revalidateOnFocus: true }),
      ) as Atom.Atom<AsyncResult.AsyncResult<GeneratedFolderPage, unknown>>;
  });
  const mediaLibraryStatus = Atom.family((revision: number) => {
    if (!generatedApi) throw new Error("Generated media API is not configured.");
    return generatedApi
      .query("default", "mediaLibraryStatus", {
        reactivityKeys: [`media:${revision}`],
        timeToLive: "5 minutes",
      })
      .pipe(
        Atom.swr({ staleTime: 0, revalidateOnMount: true, revalidateOnFocus: true }),
      ) as Atom.Atom<AsyncResult.AsyncResult<GeneratedLibraryStatus, unknown>>;
  });
  const metadata = Atom.family((key: string) => {
    const [id] = JSON.parse(key) as [string, number];
    if (!generatedApi) throw new Error("Generated media API is not configured.");
    return runtime
      .atom((get) => {
        get(mediaRevision);
        let attempt = 0;
        return Effect.suspend(() => {
          const query = generatedApi.query("default", "getMedia", {
            params: { mediaId: id },
            reactivityKeys: [`media-metadata:${id}:${attempt++}`],
            timeToLive: "0 seconds",
          });
          return Effect.acquireUseRelease(
            Effect.sync(() => registry.mount(query)),
            () => AtomRegistry.getResult(registry, query, { suspendOnWaiting: true }),
            (release) => Effect.sync(release),
          ) as Effect.Effect<Media, unknown>;
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
            const error = Cause.squash(cause);
            return Effect.fail(
              error instanceof Error
                ? error
                : new Error("Metadata request failed.", { cause: error }),
            );
          }),
          Effect.retry({ times: 3, schedule: Schedule.exponential("1 second") }),
          Effect.mapError((error) => {
            const status = error instanceof ApiFailure ? error.status : errorStatus(error);
            return new Error(
              status ? `Metadata request failed (${status}).` : "Metadata request failed.",
              { cause: error },
            );
          }),
        );
      })
      .pipe(
        Atom.setIdleTTL("5 minutes"),
        Atom.swr({ staleTime: 0, revalidateOnMount: true, revalidateOnFocus: true }),
      );
  });
  const media = (id: string, revision = registry.get(mediaRevision)) =>
    metadata(JSON.stringify([id, revision]));
  const libraryTree = (
    folderId: string | undefined,
    cursor: string | undefined,
    revision: number,
  ) => mediaTree(JSON.stringify([folderId ?? null, cursor ?? null, revision]));
  return {
    api,
    registry,
    runtime,
    generatedApi,
    media,
    mediaTree: libraryTree,
    mediaLibraryStatus,
    project,
    projectPage,
    observeJob,
    observeBatch,
    setJobLocallyCancelled(id: string, cancelled: boolean) {
      if (cancelled) locallyCancelledJobs.add(id);
      else locallyCancelledJobs.delete(id);
    },
    setBatchLocallyCancelled(id: string, cancelled: boolean) {
      if (cancelled) locallyCancelledBatches.add(id);
      else locallyCancelledBatches.delete(id);
    },
    mediaRevision,
    refreshMedia() {
      registry.update(mediaRevision, (revision) => revision + 1);
    },
  };
}

/** Solid observes the native result; it does not maintain another server-data cache. */
export function useServerAtom<A, E = Error>(
  atom: Accessor<Atom.Atom<AsyncResult.AsyncResult<A, E>>>,
) {
  const result = useAtomValue(atom);
  const value = createMemo(() => Option.getOrUndefined(AsyncResult.value(result())));
  const error = createMemo(() => {
    const current = result();
    if (!AsyncResult.isFailure(current)) return;
    const cause = Cause.squash(current.cause);
    return cause instanceof Error ? cause : new Error("Request could not be completed.");
  });
  return { result, value, error, waiting: () => result().waiting };
}

/** Polling is an atom-owned Effect: refresh/disposal interrupts fetch and sleep together. */
export function pollAtom<A, R = never>(
  runtime: Atom.AtomRuntime<R>,
  fetch: Effect.Effect<A, Error, R>,
  active: (value: A) => boolean,
  intervalMs: number,
): Atom.Atom<AsyncResult.AsyncResult<A, Error>> {
  return runtime.atom<A, Error>((get) =>
    Effect.gen(function* () {
      while (true) {
        get.setSelf(AsyncResult.waitingFrom(get.self<AsyncResult.AsyncResult<A, Error>>()));
        const exit = yield* Effect.exit(fetch);
        get.setSelf(
          AsyncResult.fromExitWithPrevious(exit, get.self<AsyncResult.AsyncResult<A, Error>>()),
        );
        if (Exit.isSuccess(exit) && !active(exit.value)) return exit.value;
        yield* Effect.sleep(intervalMs);
      }
    }),
  );
}

/** Awaiting a resource holds its native registry mount only for that operation. */
export function readServerAtom<A, E>(
  server: ServerState,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Effect.Effect<A, E> {
  return Effect.acquireUseRelease(
    Effect.sync(() => server.registry.mount(atom)),
    () => AtomRegistry.getResult(server.registry, atom, { suspendOnWaiting: true }),
    (release) => Effect.sync(release),
  );
}
