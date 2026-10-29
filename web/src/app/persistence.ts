import * as BrowserKeyValueStore from "@effect/platform-browser/BrowserKeyValueStore";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Atom from "effect/reactivity/Atom";
import type * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";

const failedBrowserStorage = (cause: unknown): KeyValueStore.KeyValueStoreError =>
  new KeyValueStore.KeyValueStoreError({
    method: "get",
    message: "Browser storage is unavailable.",
    cause,
  });

const unavailableStore = (cause: unknown): KeyValueStore.KeyValueStore =>
  KeyValueStore.makeStringOnly({
    get: (key) =>
      Effect.fail(
        new KeyValueStore.KeyValueStoreError({
          method: "get",
          key,
          message: "Browser storage is unavailable.",
          cause,
        }),
      ),
    set: (key) =>
      Effect.fail(
        new KeyValueStore.KeyValueStoreError({
          method: "set",
          key,
          message: "Browser storage is unavailable.",
          cause,
        }),
      ),
    remove: (key) =>
      Effect.fail(
        new KeyValueStore.KeyValueStoreError({
          method: "remove",
          key,
          message: "Browser storage is unavailable.",
          cause,
        }),
      ),
    clear: Effect.fail(failedBrowserStorage(cause)),
    size: Effect.fail(failedBrowserStorage(cause)),
  });

/** A denied localStorage getter becomes a reportable storage failure, not a broken workspace runtime. */
export const browserPersistenceLayer = Layer.catchCause(
  BrowserKeyValueStore.layerLocalStorage,
  (cause) =>
    Cause.hasInterrupts(cause)
      ? Layer.effect(KeyValueStore.KeyValueStore, Effect.failCause(cause))
      : Layer.succeed(KeyValueStore.KeyValueStore, unavailableStore(cause)),
);

export type PersistenceFailure = {
  operation: "read" | "write";
  error: Error;
};

export type PersistenceStatus = {
  initialized: boolean;
  write: "idle" | "saving" | "saved" | "failed";
  failure?: PersistenceFailure;
};

export type PersistedValue<S extends Schema.ConstraintCodec<unknown, unknown, never, never>> = {
  readonly value: Atom.Writable<S["Type"], S["Type"]>;
  readonly status: Atom.Atom<PersistenceStatus>;
  readonly initialize: Atom.Atom<AsyncResult.AsyncResult<void, never>>;
  readonly save: Atom.AtomResultFn<S["Type"], void, Error>;
};

function errorFromCause(cause: Cause.Cause<unknown>, fallback: string): Error {
  const error = Cause.squash(cause);
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}

/** One workspace policy for schema-decoded values; registry ownership scopes reads and writes. */
export function createPersistencePolicy(
  runtime: Atom.AtomRuntime<KeyValueStore.KeyValueStore>,
  registry: AtomRegistry.AtomRegistry,
) {
  function value<S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(options: {
    key: string;
    schema: S;
    defaultValue: S["Type"];
    removeWhen?: (value: S["Type"]) => boolean;
    legacy?: {
      restore: (
        store: KeyValueStore.KeyValueStore,
        rawCurrent?: string,
      ) => Effect.Effect<S["Type"] | undefined, KeyValueStore.KeyValueStoreError>;
      onDecodeFailure?: boolean;
    };
  }): PersistedValue<S> {
    const current = Atom.keepAlive(Atom.make(options.defaultValue));
    const status = Atom.keepAlive(
      Atom.make<PersistenceStatus>({ initialized: false, write: "idle" }),
    );
    let edited = false;

    const jsonSchema = Schema.fromJsonString(Schema.toCodecJson(options.schema));
    const decodeStored = Schema.decodeUnknownEffect(jsonSchema);
    const initialize = runtime.atom(
      KeyValueStore.KeyValueStore.use((store) =>
        Effect.gen(function* () {
          const currentRaw = yield* store.get(options.key);
          let restored: S["Type"] | undefined;
          let migrate = false;

          if (currentRaw === undefined) {
            if (options.legacy) {
              restored = yield* options.legacy.restore(store);
              migrate = restored !== undefined;
            }
          } else {
            const decoded = yield* Effect.exit(decodeStored(currentRaw));
            if (Exit.isSuccess(decoded)) {
              restored = decoded.value;
            } else if (Cause.hasInterrupts(decoded.cause)) {
              return yield* Effect.failCause(decoded.cause);
            } else if (options.legacy?.onDecodeFailure) {
              restored = yield* options.legacy.restore(store, currentRaw);
              if (restored === undefined) return yield* Effect.failCause(decoded.cause);
              migrate = true;
            } else {
              return yield* Effect.failCause(decoded.cause);
            }
          }

          if (!migrate || restored === undefined || edited) return restored;

          // Recheck before publication so a newer value in another tab stays authoritative.
          const latestRaw = yield* store.get(options.key);
          if (latestRaw !== currentRaw) {
            if (latestRaw === undefined) return undefined;
            return yield* decodeStored(latestRaw);
          }
          if (edited) return undefined;

          registry.update(status, (previous): PersistenceStatus => ({
            ...previous,
            write: "saving",
          }));
          const write = yield* Effect.exit(
            KeyValueStore.toSchemaStore(store, options.schema).set(options.key, restored),
          );
          if (Exit.isFailure(write)) {
            if (Cause.hasInterrupts(write.cause)) return yield* Effect.failCause(write.cause);
            registry.update(status, (previous): PersistenceStatus => ({
              ...previous,
              write: "failed",
              failure: {
                operation: "write",
                error: errorFromCause(write.cause, "Browser value could not be saved."),
              },
            }));
          } else {
            registry.update(status, (previous): PersistenceStatus => ({
              ...previous,
              write: "saved",
              failure: undefined,
            }));
          }
          return restored;
        }),
      ).pipe(
        Effect.tap((stored) =>
          Effect.sync(() => {
            if (!edited && stored !== undefined) registry.set(current, stored);
            registry.update(status, (previous): PersistenceStatus => ({
              ...previous,
              initialized: true,
            }));
          }),
        ),
        Effect.asVoid,
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt;
          registry.update(status, (previous): PersistenceStatus => ({
            ...previous,
            initialized: true,
            failure: {
              operation: "read",
              error: errorFromCause(cause, "Browser value could not be read."),
            },
          }));
          return Effect.void;
        }),
      ),
    );
    const save = runtime.fn((next: S["Type"]) =>
      Effect.gen(function* () {
        yield* AtomRegistry.getResult(registry, initialize, { suspendOnWaiting: true });
        registry.update(status, (previous): PersistenceStatus => ({
          ...previous,
          write: "saving",
        }));
        yield* KeyValueStore.KeyValueStore.use((store) =>
          options.removeWhen?.(next)
            ? store.remove(options.key)
            : KeyValueStore.toSchemaStore(store, options.schema).set(options.key, next),
        );
        registry.update(status, (previous): PersistenceStatus => ({
          ...previous,
          write: "saved",
          failure: undefined,
        }));
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt;
          const error = errorFromCause(cause, "Browser value could not be saved.");
          registry.update(status, (previous): PersistenceStatus => ({
            ...previous,
            write: "failed",
            failure: { operation: "write", error },
          }));
          return Effect.fail(error);
        }),
      ),
    );
    const writable = Atom.writable(
      (get) => get(current),
      (context, next: S["Type"]) => {
        edited = true;
        context.set(current, next);
        context.set(save, next);
      },
    );

    // The workspace registry owns both mounts, so disposal interrupts a pending read or write.
    registry.mount(initialize);
    registry.mount(save);
    return { value: writable, status, initialize, save };
  }

  return { value };
}
