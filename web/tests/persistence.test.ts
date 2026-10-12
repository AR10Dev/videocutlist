import { Effect, Layer, Schema } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { describe, expect, it } from "@effect/vitest";
import { browserPersistenceLayer, createPersistencePolicy } from "../src/app/persistence";

const valueSchema = Schema.Struct({ value: Schema.Number.check(Schema.isInt()) });

type StoreOverrides = {
  get?: (key: string) => Effect.Effect<string | undefined, KeyValueStore.KeyValueStoreError>;
  set?: (key: string, value: string) => Effect.Effect<void, KeyValueStore.KeyValueStoreError>;
  remove?: (key: string) => Effect.Effect<void, KeyValueStore.KeyValueStoreError>;
};

function testRuntime(overrides: StoreOverrides = {}) {
  const values = new Map<string, string>();
  const store = KeyValueStore.makeStringOnly({
    get: overrides.get ?? ((key) => Effect.sync(() => values.get(key))),
    set:
      overrides.set ??
      ((key, value) =>
        Effect.sync(() => {
          values.set(key, value);
        })),
    remove: overrides.remove ?? ((key) => Effect.sync(() => void values.delete(key))),
    clear: Effect.sync(() => values.clear()),
    size: Effect.sync(() => values.size),
  });
  return {
    values,
    runtime: Atom.runtime(Layer.succeed(KeyValueStore.KeyValueStore, store)),
  };
}

const makeValue = (
  runtime: Atom.AtomRuntime<KeyValueStore.KeyValueStore>,
  registry: AtomRegistry.AtomRegistry,
) =>
  createPersistencePolicy(runtime, registry).value({
    key: "preferences",
    schema: valueSchema,
    defaultValue: { value: 0 },
  });

function scheduledRegistry() {
  const tasks: Array<{ run: () => void; cancelled: boolean }> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (run) => {
      const task = { run, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
  });
  const flush = () => {
    while (tasks.length > 0) {
      const task = tasks.shift();
      if (task && !task.cancelled) task.run();
    }
  };
  return { registry, flush };
}

async function runWithScheduledRegistry<A>(
  effect: Effect.Effect<A, unknown>,
  flush: () => void,
): Promise<A> {
  const result = Effect.runPromise(effect);
  let settled = false;
  result.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) {
    flush();
    await Promise.resolve();
  }
  return result;
}

describe("workspace schema persistence", () => {
  it("waits for restoration before saving an edit and round-trips through the schema", async () => {
    let finishRead!: (value: string | undefined) => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => (readStarted = resolve));
    const { runtime, values } = testRuntime({
      get: () =>
        Effect.tryPromise({
          try: () =>
            new Promise<string | undefined>((resolve) => {
              finishRead = resolve;
              readStarted();
            }),
          catch: (cause) =>
            new KeyValueStore.KeyValueStoreError({
              method: "get",
              key: "preferences",
              message: "read failed",
              cause,
            }),
        }),
    });
    const registry = AtomRegistry.make();
    const persisted = makeValue(runtime, registry);

    await started;
    registry.set(persisted.value, { value: 7 });
    expect(values.size).toBe(0);
    expect(registry.get(persisted.value)).toEqual({ value: 7 });

    finishRead?.('{"value":2}');
    await expect(
      Effect.runPromise(
        AtomRegistry.getResult(registry, persisted.initialize, { suspendOnWaiting: true }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(
        AtomRegistry.getResult(registry, persisted.save, { suspendOnWaiting: true }),
      ),
    ).resolves.toBeUndefined();

    expect(registry.get(persisted.value)).toEqual({ value: 7 });
    expect(values.get("preferences")).toBe('{"value":7}');
    expect(registry.get(persisted.status)).toMatchObject({
      initialized: true,
      write: "saved",
      failure: undefined,
    });
    registry.dispose();
  });

  it("uses defaults and reports malformed or denied reads without failing initialization", async () => {
    const cases: Array<{
      label: string;
      read: () => Effect.Effect<string | undefined, KeyValueStore.KeyValueStoreError>;
      failure?: boolean;
    }> = [
      { label: "missing", read: () => Effect.succeed(undefined) },
      { label: "malformed", read: () => Effect.succeed('{"value":"wrong"}'), failure: true },
      {
        label: "denied",
        read: () =>
          Effect.fail(
            new KeyValueStore.KeyValueStoreError({
              method: "get",
              key: "preferences",
              message: "Storage access denied.",
            }),
          ),
        failure: true,
      },
    ];

    for (const testCase of cases) {
      const { runtime } = testRuntime({ get: testCase.read });
      const registry = AtomRegistry.make();
      const persisted = makeValue(runtime, registry);
      await expect(
        Effect.runPromise(
          AtomRegistry.getResult(registry, persisted.initialize, { suspendOnWaiting: true }),
        ),
      ).resolves.toBeUndefined();
      expect(registry.get(persisted.value)).toEqual({ value: 0 });
      expect(registry.get(persisted.status).initialized).toBe(true);
      expect(Boolean(registry.get(persisted.status).failure)).toBe(Boolean(testCase.failure));
      registry.dispose();
    }
  });

  it("reports a denied localStorage getter as an initialization failure", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage access denied.", "SecurityError");
      },
    });
    const registry = AtomRegistry.make();
    const runtime = Atom.runtime(browserPersistenceLayer);
    const persisted = makeValue(runtime, registry);
    try {
      await expect(
        Effect.runPromise(
          AtomRegistry.getResult(registry, persisted.initialize, { suspendOnWaiting: true }),
        ),
      ).resolves.toBeUndefined();
      expect(registry.get(persisted.value)).toEqual({ value: 0 });
      expect(registry.get(persisted.status)).toMatchObject({
        initialized: true,
        failure: { operation: "read" },
      });
    } finally {
      registry.dispose();
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("retains restored values initialized before the first subscriber", async () => {
    let reads = 0;
    const { runtime, values } = testRuntime({
      get: (key) => {
        reads++;
        return Effect.sync(() => values.get(key));
      },
    });
    values.set("preferences", '{"value":3}');
    const { registry, flush } = scheduledRegistry();
    const persisted = makeValue(runtime, registry);

    await runWithScheduledRegistry(
      AtomRegistry.getResult(registry, persisted.initialize, { suspendOnWaiting: true }),
      flush,
    );
    flush();
    expect(registry.getNodes().has(persisted.value)).toBe(false);
    expect(registry.getNodes().has(persisted.status)).toBe(true);

    const unmount = registry.mount(persisted.value);
    expect(registry.get(persisted.value)).toEqual({ value: 3 });
    expect(values.get("preferences")).toBe('{"value":3}');
    expect(reads).toBe(1);
    unmount();
    flush();
    registry.dispose();
  });

  it.each(["saved", "failed"] as const)(
    "retains edits and %s write status after subscriber remount",
    async (outcome) => {
      let reads = 0;
      let writeAttempts = 0;
      const { runtime, values } = testRuntime({
        get: () => {
          reads++;
          return Effect.succeed(undefined);
        },
        set: (key, value) => {
          writeAttempts++;
          return outcome === "failed"
            ? Effect.fail(
                new KeyValueStore.KeyValueStoreError({
                  method: "set",
                  key,
                  message: "Quota exceeded.",
                }),
              )
            : Effect.sync(() => void values.set(key, value));
        },
      });
      const { registry, flush } = scheduledRegistry();
      const persisted = makeValue(runtime, registry);
      try {
        await runWithScheduledRegistry(
          AtomRegistry.getResult(registry, persisted.initialize, { suspendOnWaiting: true }),
          flush,
        );
        const unmount = registry.mount(persisted.value);
        registry.set(persisted.value, { value: 12 });
        const saving = runWithScheduledRegistry(
          AtomRegistry.getResult(registry, persisted.save, { suspendOnWaiting: true }),
          flush,
        );
        if (outcome === "failed") await expect(saving).rejects.toThrow("Quota exceeded.");
        else await expect(saving).resolves.toBeUndefined();
        expect(registry.get(persisted.value)).toEqual({ value: 12 });
        expect(registry.get(persisted.status)).toMatchObject({
          initialized: true,
          write: outcome,
          failure: outcome === "failed" ? { operation: "write" } : undefined,
        });
        unmount();
        flush();
        expect(registry.getNodes().has(persisted.value)).toBe(false);

        const remount = registry.mount(persisted.value);
        expect(registry.get(persisted.value)).toEqual({ value: 12 });
        expect(registry.get(persisted.status)).toMatchObject({
          initialized: true,
          write: outcome,
          failure: outcome === "failed" ? { operation: "write" } : undefined,
        });
        expect(values.get("preferences")).toBe(outcome === "saved" ? '{"value":12}' : undefined);
        expect(writeAttempts).toBe(1);
        expect(reads).toBe(1);
        remount();
        flush();
      } finally {
        registry.dispose();
      }
    },
  );

  it("interrupts a pending initial read when the workspace registry is disposed", async () => {
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => (readStarted = resolve));
    let interrupted!: () => void;
    const aborted = new Promise<void>((resolve) => (interrupted = resolve));
    const { runtime } = testRuntime({
      get: () =>
        Effect.tryPromise({
          try: (signal) =>
            new Promise<string | undefined>((_resolve, reject) => {
              readStarted();
              signal.addEventListener(
                "abort",
                () => {
                  interrupted();
                  reject(new DOMException("Interrupted", "AbortError"));
                },
                { once: true },
              );
            }),
          catch: (cause) =>
            new KeyValueStore.KeyValueStoreError({
              method: "get",
              key: "preferences",
              message: "read failed",
              cause,
            }),
        }),
    });
    const registry = AtomRegistry.make();
    makeValue(runtime, registry);
    await started;
    registry.dispose();
    await aborted;
  });
});

it("schema-policy removal preserves nonfatal failure status and uses the same initialization", async () => {
  const { runtime, values } = testRuntime();
  const registry = AtomRegistry.make();
  const value = createPersistencePolicy(runtime, registry).value({
    key: "recovery",
    schema: Schema.NullOr(valueSchema),
    defaultValue: null,
    removeWhen: (value) => value === null,
  });
  try {
    registry.set(value.value, { value: 7 });
    await Effect.runPromise(
      AtomRegistry.getResult(registry, value.save, { suspendOnWaiting: true }),
    );
    expect(values.has("recovery")).toBe(true);
    registry.set(value.value, null);
    await Effect.runPromise(
      AtomRegistry.getResult(registry, value.save, { suspendOnWaiting: true }),
    );
    expect(values.has("recovery")).toBe(false);
    expect(registry.get(value.status).write).toBe("saved");
  } finally {
    registry.dispose();
  }
  const failing = testRuntime({
    remove: (key) =>
      Effect.fail(
        new KeyValueStore.KeyValueStoreError({ method: "remove", key, message: "denied" }),
      ),
  });
  const deniedRegistry = AtomRegistry.make();
  const denied = createPersistencePolicy(failing.runtime, deniedRegistry).value({
    key: "recovery",
    schema: Schema.NullOr(valueSchema),
    defaultValue: null,
    removeWhen: (value) => value === null,
  });
  try {
    deniedRegistry.set(denied.value, null);
    const result = await Effect.runPromise(
      Effect.exit(AtomRegistry.getResult(deniedRegistry, denied.save, { suspendOnWaiting: true })),
    );
    expect(result._tag).toBe("Failure");
    expect(deniedRegistry.get(denied.value)).toBeNull();
    expect(deniedRegistry.get(denied.status)).toMatchObject({
      initialized: true,
      write: "failed",
      failure: { operation: "write" },
    });
  } finally {
    deniedRegistry.dispose();
  }
});
