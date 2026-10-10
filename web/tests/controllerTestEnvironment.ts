import { RegistryProvider, RegistryContext } from "@effect/atom-solid";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createComponent, createRoot, untrack, useContext } from "solid-js";
import { createApiClient, type ApiClient, type ClientConfiguration } from "../src/api";
import { createServerState, type ServerState } from "../src/features/app/server";

export const controllerTestConfiguration: ClientConfiguration = {
  serverBaseUrl: "http://localhost",
  authentication: { type: "none" },
};

type TestEnvironment = {
  registry: AtomRegistry.AtomRegistry;
  configuration: ClientConfiguration;
  api: ApiClient;
  server: ServerState;
};
type GlobalOverrides = {
  configuration?: ClientConfiguration;
  fetch?: typeof globalThis.fetch;
  storage?: Storage;
};

/** Owns the shared test globals, Solid root, registry, API client, and server state. */
export function createControllerTestRoot<A>(
  initialize: (environment: TestEnvironment) => A,
  overrides: GlobalOverrides = {},
) {
  const restore: Array<() => void> = [];
  let disposeRoot: (() => void) | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      disposeRoot?.();
    } finally {
      for (const restoreGlobal of restore.reverse()) restoreGlobal();
    }
  };
  const installGlobal = (key: "fetch" | "localStorage", value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      writable: true,
      value,
    });
    restore.push(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  };

  try {
    if (overrides.fetch) installGlobal("fetch", overrides.fetch);
    if (overrides.storage) installGlobal("localStorage", overrides.storage);
    let value!: A;
    let testEnvironment!: TestEnvironment;
    createRoot((cleanup) => {
      disposeRoot = cleanup;
      createComponent(RegistryProvider, {
        get children() {
          untrack(() => {
            const registry = useContext(RegistryContext);
            const configuration = overrides.configuration ?? controllerTestConfiguration;
            const api = createApiClient(configuration);
            testEnvironment = {
              registry,
              configuration,
              api,
              server: createServerState(api, registry, configuration),
            };
            value = initialize(testEnvironment);
          });
          return null;
        },
      });
    });
    return { ...testEnvironment, value, dispose };
  } catch (error) {
    try {
      dispose();
    } catch {
      // Preserve the initialization failure while still restoring installed globals.
    }
    throw error;
  }
}

/** Run an async exercise with cleanup for successful, thrown, and rejected cases. */
export async function withControllerTestRoot<A>(
  initialize: (environment: TestEnvironment) => A,
  exercise: (value: A) => Promise<void>,
  overrides: GlobalOverrides = {},
) {
  const root = createControllerTestRoot(initialize, overrides);
  try {
    await exercise(root.value);
  } finally {
    root.dispose();
  }
}
