import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createRoot, onCleanup } from "solid-js";
import { describe, expect, it } from "vitest";
import { createControllerTestRoot, withControllerTestRoot } from "./controllerTestEnvironment";
import { memoryStorage } from "./memoryStorage";

const testFetch: typeof globalThis.fetch = () => Promise.resolve(Response.json({}));
const overrides = () => {
  const storage = memoryStorage();
  return { values: { fetch: testFetch, storage }, storage };
};
const descriptors = () => ({
  fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
  storage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
});
const expectRestored = (original: ReturnType<typeof descriptors>) => {
  expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(original.fetch);
  expect(Object.getOwnPropertyDescriptor(globalThis, "localStorage")).toEqual(original.storage);
};
const expectDisposed = (registry: AtomRegistry.AtomRegistry) => {
  expect(() => registry.get(Atom.make(1))).toThrow("registry is disposed");
};
function trackNestedRoot(cleaned: () => void) {
  let dispose!: () => void;
  createRoot((cleanup) => {
    dispose = cleanup;
    onCleanup(cleaned);
  });
  onCleanup(dispose);
}

const exercises = [
  {
    name: "synchronous throw",
    error: "exercise failed",
    run: () => {
      throw new Error("exercise failed");
    },
  },
  {
    name: "async rejection",
    error: "exercise failed",
    run: async () => {
      throw new Error("exercise failed");
    },
  },
  { name: "success", run: async () => undefined },
];

describe("controller test environment cleanup", () => {
  it("restores globals and disposes registries and nested roots after initialization throws", () => {
    const original = descriptors();
    const installed = overrides();
    let registry!: AtomRegistry.AtomRegistry;
    let rootCleaned = false;
    let nestedCleaned = false;
    expect(() =>
      createControllerTestRoot((environment) => {
        registry = environment.registry;
        expect(globalThis.fetch).toBe(testFetch);
        expect(globalThis.localStorage).toBe(installed.storage);
        onCleanup(() => (rootCleaned = true));
        trackNestedRoot(() => (nestedCleaned = true));
        throw new Error("initialization failed");
      }, installed.values),
    ).toThrow("initialization failed");
    expectRestored(original);
    expect(rootCleaned).toBe(true);
    expect(nestedCleaned).toBe(true);
    expectDisposed(registry);
  });

  it.each(exercises)(
    "restores globals and disposes the registry after $name",
    async ({ error, run }) => {
      const original = descriptors();
      const installed = overrides();
      let registry!: AtomRegistry.AtomRegistry;
      const exercise = withControllerTestRoot(
        (environment) => {
          registry = environment.registry;
          return undefined;
        },
        async () => {
          expect(globalThis.fetch).toBe(testFetch);
          expect(globalThis.localStorage).toBe(installed.storage);
          await run();
        },
        installed.values,
      );
      if (error) await expect(exercise).rejects.toThrow(error);
      else await exercise;
      expectRestored(original);
      expectDisposed(registry);
    },
  );

  it("restores nested environments in reverse disposal order", () => {
    const original = descriptors();
    const first = overrides();
    const firstFetch: typeof globalThis.fetch = () =>
      Promise.resolve(Response.json({ first: true }));
    first.values.fetch = firstFetch;
    const firstRoot = createControllerTestRoot(() => undefined, first.values);
    const firstDescriptors = descriptors();
    const second = overrides();
    const secondFetch: typeof globalThis.fetch = () =>
      Promise.resolve(Response.json({ second: true }));
    second.values.fetch = secondFetch;
    const secondRoot = createControllerTestRoot(() => undefined, second.values);
    expect(globalThis.fetch).toBe(secondFetch);
    expect(globalThis.localStorage).toBe(second.storage);

    secondRoot.dispose();
    expectRestored(firstDescriptors);
    expect(globalThis.fetch).toBe(firstFetch);
    expect(globalThis.localStorage).toBe(first.storage);
    firstRoot.dispose();
    expectRestored(original);
  });

  it("restores globals and disposes nested roots on explicit, repeated disposal", () => {
    const original = descriptors();
    const installed = overrides();
    let nestedCleaned = false;
    const root = createControllerTestRoot(() => {
      expect(globalThis.fetch).toBe(testFetch);
      expect(globalThis.localStorage).toBe(installed.storage);
      trackNestedRoot(() => (nestedCleaned = true));
    }, installed.values);
    root.dispose();
    root.dispose();
    expectRestored(original);
    expect(nestedCleaned).toBe(true);
    expectDisposed(root.registry);
  });
});
