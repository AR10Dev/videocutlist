import { useAtomValue } from "@effect/atom-solid";
import { Cause, Effect, Exit, Layer, Option, Schedule } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as AtomHttpApi from "effect/reactivity/AtomHttpApi";
import { createMemo, type Accessor } from "solid-js";
import {
  apiJson,
  ApiFailure,
  createApiClient,
  createNativeHttpClientLayer,
  type ApiClient,
  type ClientConfiguration,
} from "../../api";
import { VideoCutListApi } from "../../generated/effect-api";
import type { components } from "../../generated/api";

type Media = components["schemas"]["Media"];

export interface ServerState {
  readonly api: ApiClient;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly runtime: Atom.AtomRuntime<never>;
  readonly generatedApi?: ReturnType<typeof createGeneratedApi>;
  readonly media: (id: string) => Atom.Atom<AsyncResult.AsyncResult<Media, Error>>;
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
  api: ApiClient,
  registry: AtomRegistry.AtomRegistry,
  configuration?: ClientConfiguration,
) {
  const generatedApi = configuration ? createGeneratedApi(configuration) : undefined;
  const runtime = Atom.runtime(Layer.empty);
  const mediaRevision = Atom.make(0);
  const media = Atom.family((id: string) =>
    runtime
      .atom((get) => {
        get(mediaRevision);
        return apiJson<Media>(api, `media/${encodeURIComponent(id)}`).pipe(
          Effect.retry({ times: 3, schedule: Schedule.exponential("1 second") }),
          Effect.mapError(
            (error) =>
              new Error(
                error instanceof ApiFailure
                  ? `Metadata request failed (${error.status}).`
                  : error.message,
                { cause: error },
              ),
          ),
        );
      })
      .pipe(
        Atom.setIdleTTL("5 minutes"),
        Atom.swr({ staleTime: 0, revalidateOnMount: true, revalidateOnFocus: true }),
      ),
  );
  return {
    api,
    registry,
    runtime,
    generatedApi,
    media,
    mediaRevision,
    refreshMedia() {
      registry.update(mediaRevision, (revision) => revision + 1);
    },
  };
}

/** Solid observes the native result; it does not maintain another server-data cache. */
export function useServerAtom<A>(atom: Accessor<Atom.Atom<AsyncResult.AsyncResult<A, Error>>>) {
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
export function readServerAtom<A>(
  server: ServerState,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, Error>>,
): Effect.Effect<A, Error> {
  return Effect.acquireUseRelease(
    Effect.sync(() => server.registry.mount(atom)),
    () => AtomRegistry.getResult(server.registry, atom, { suspendOnWaiting: true }),
    (release) => Effect.sync(release),
  );
}
