import { isTerminalState } from "../features/queue/jobState";
import type * as EffectApiTypes from "../generated/effect-api";
import { useAtomValue } from "@effect/atom-solid";
import { Cause, Effect, Option, Schedule, Schema, Stream, type Context } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as AtomHttpApi from "effect/reactivity/AtomHttpApi";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { createMemo, type Accessor } from "solid-js";
import {
  ApiFailure,
  apiErrorStatus,
  createApiClient,
  createNativeHttpClientLayer,
  type ApiClient,
  type ClientConfiguration,
  type NativeMediaApiClient,
} from "../api";
import { VideoCutListApi } from "../generated/effect-api";
import {
  Batch as BatchSchema,
  Job as JobSchema,
  type Batch,
  type FolderPage as GeneratedFolderPage,
  type Job,
  type LibraryStatus as GeneratedLibraryStatus,
  type Project,
  type ProjectPage,
} from "../generated/effect-api";
import { observeSnapshots } from "../features/queue/jobStream";
import {
  PANEL_PREFERENCES_KEY,
  defaultPanelPreferences,
  panelPreferencesSchema,
} from "./panelPreferences";
import { defaultWorkspacePanelState, type WorkspacePanelState } from "./panelState";
import {
  browserPreferencesKey,
  browserPreferencesSchema,
  defaultBrowserPreferences,
} from "../features/settings/model";
import {
  browserPersistenceLayer,
  createPersistencePolicy,
  type PersistedValue,
} from "./persistence";

type Media = EffectApiTypes.Media;

export interface ServerState {
  readonly api: ApiClient & Pick<NativeMediaApiClient, "mediaRequest">;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly runtime: Atom.AtomRuntime<KeyValueStore.KeyValueStore>;
  readonly persistence: ReturnType<typeof createPersistencePolicy>;
  readonly preferences: PersistedValue<typeof browserPreferencesSchema>;
  readonly panelPreferences: PersistedValue<typeof panelPreferencesSchema>;
  readonly workspacePanelState: Atom.Writable<WorkspacePanelState>;
  readonly generatedApi: ReturnType<typeof createGeneratedApi>;
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

/** One workspace owns its registry, command runtime, resource identities and dependency graph. */
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
  configuration: ClientConfiguration,
) {
  const generatedApi = createGeneratedApi(configuration);
  // Mount runtime.fn command atoms in this registry, dispatch by setting their input, read
  // completion with AtomRegistry.getResult, and interrupt with Atom.Interrupt. The workspace
  // RegistryProvider owns disposal; outer access bootstrap has a separate provider. Interruption
  // stops client work, not a server mutation.
  const runtime = Atom.runtime(browserPersistenceLayer);
  const persistence = createPersistencePolicy(runtime, registry);
  const preferences = persistence.value({
    key: browserPreferencesKey,
    schema: browserPreferencesSchema,
    defaultValue: defaultBrowserPreferences,
  });
  const panelPreferences = persistence.value({
    key: PANEL_PREFERENCES_KEY,
    schema: panelPreferencesSchema,
    defaultValue: defaultPanelPreferences(),
  });
  const workspacePanelState = Atom.keepAlive(
    Atom.make<WorkspacePanelState>(defaultWorkspacePanelState),
  );
  const mediaRevision = Atom.keepAlive(Atom.make(0));
  const locallyCancelledJobs = new Set<string>();
  const locallyCancelledBatches = new Set<string>();
  const jobAtoms = new Map<string, Atom.Atom<AsyncResult.AsyncResult<Job, Error>>>();
  const batchAtoms = new Map<string, Atom.Atom<AsyncResult.AsyncResult<Batch, Error>>>();
  const jobAtom = (id: string, initial?: Job) => {
    if (initial) initial = Schema.decodeUnknownSync(JobSchema)(initial);
    if (initial && initial.id !== id) throw new Error("Job snapshot does not match its identity.");
    let atom = jobAtoms.get(id);
    if (!atom) {
      const terminal = isTerminalState(initial?.state);
      if (initial && terminal) {
        atom = Atom.make(AsyncResult.success(initial));
      } else {
        let latestRevision = initial?.revision ?? 0;
        let terminal = false;
        const isValidSnapshot = (snapshot: Job) =>
          snapshot.id === id && snapshot.revision > latestRevision;
        const isTerminalSnapshot = (snapshot: Job) =>
          isValidSnapshot(snapshot) && isTerminalState(snapshot.state);
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
      atom = Atom.keepAlive(atom);
      jobAtoms.set(id, atom);
    }
    return atom;
  };
  const equivalentBatch = Schema.toEquivalence(BatchSchema);
  const batchAtom = (id: string, initial?: Batch) => {
    if (initial) initial = Schema.decodeUnknownSync(BatchSchema)(initial);
    if (initial && initial.batchId !== id)
      throw new Error("Batch snapshot does not match its identity.");
    let atom = batchAtoms.get(id);
    if (!atom) {
      const latestRevisions = new Map(initial?.jobs.map((job) => [job.id, job.revision]) ?? []);
      let latestSnapshot = initial;
      let terminal = isTerminalState(initial?.state);
      const isValidSnapshot = (snapshot: Batch) =>
        snapshot.batchId === id &&
        (!latestSnapshot || !equivalentBatch(snapshot, latestSnapshot)) &&
        !snapshot.jobs.some((job) => job.revision < (latestRevisions.get(job.id) ?? 0));
      const isTerminalSnapshot = (snapshot: Batch) =>
        isValidSnapshot(snapshot) && isTerminalState(snapshot.state);
      atom = terminal
        ? Atom.make(AsyncResult.success(initial!))
        : runtime.atom<Batch, Error>(
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
                for (const job of snapshot.jobs) latestRevisions.set(job.id, job.revision);
                latestSnapshot = snapshot;
                terminal = terminalSnapshot;
                return true;
              }),
            ),
            initial ? { initialValue: initial } : undefined,
          );
      atom = Atom.keepAlive(atom);
      batchAtoms.set(id, atom);
    }
    return atom;
  };
  // Durable job observations belong to the workspace: keepAlive retains their status and
  // stream across component/session unsubscribe. Those observers own only their native
  // subscription handles; RegistryProvider disposal releases all workspace resources.
  const observeJob = (id: string, initial?: Job) => {
    const atom = jobAtom(id, initial);
    registry.get(atom);
    return atom;
  };
  const observeBatch = (id: string, initial?: Batch) => {
    const atom = batchAtom(id, initial);
    registry.get(atom);
    return atom;
  };
  const project = (id: string) =>
    generatedApi.query("default", "getProject", { params: { projectId: id } });
  const projectPage = (query: { limit?: number; cursor?: string }) =>
    generatedApi.query("default", "listProjects", { query });
  const mediaTree = Atom.family((key: string) => {
    const [folderId, cursor, revision] = JSON.parse(key) as [string | null, string | null, number];
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
            const status = error instanceof ApiFailure ? error.status : apiErrorStatus(error);
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
    persistence,
    preferences,
    panelPreferences,
    workspacePanelState,
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

export function serverResultError(
  result: AsyncResult.AsyncResult<unknown, unknown>,
): Error | undefined {
  if (!AsyncResult.isFailure(result)) return;
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error : new Error("Request could not be completed.");
}

/** Solid observes the native result; it does not maintain another server-data cache. */
export function useServerAtom<A, E = Error>(
  atom: Accessor<Atom.Atom<AsyncResult.AsyncResult<A, E>>>,
) {
  const result = useAtomValue(atom);
  const value = createMemo(() => Option.getOrUndefined(AsyncResult.value(result())));
  const error = createMemo(() => serverResultError(result()));
  return { result, value, error, waiting: () => result().waiting };
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

/** Keep the generated runtime alive for independent typed calls, including concurrent siblings. */
export function runGeneratedRequest<A, E>(
  server: ServerState,
  request: Effect.Effect<A, E, Context.Service.Identifier<ServerState["generatedApi"]>>,
): Effect.Effect<A, E> {
  return Effect.acquireUseRelease(
    Effect.sync(() => server.registry.mount(server.generatedApi.runtime)),
    () =>
      readServerAtom(server, server.generatedApi.runtime).pipe(
        Effect.flatMap((services) => request.pipe(Effect.provideContext(services))),
      ),
    (release) => Effect.sync(release),
  );
}

/** Run a serial/single-owner mutation while mounted; endpoint-singletons supersede concurrent calls. */
export function runServerMutation<Arg, A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.AtomResultFn<Arg, A, E>,
  argument: Arg,
): Effect.Effect<A, E> {
  return Effect.acquireUseRelease(
    Effect.sync(() => registry.mount(atom)),
    () => {
      registry.set(atom, argument);
      return AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
    },
    (release) =>
      Effect.sync(() => {
        registry.set(atom, Atom.Reset);
        release();
      }),
  );
}
