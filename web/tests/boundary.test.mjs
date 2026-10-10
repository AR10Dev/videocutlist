import { describe, expect, it } from "vitest";
import { adapters, checkDirectory, checkSource } from "../scripts/check-boundary.mjs";
import { fileURLToPath } from "node:url";

describe("presentation boundary", () => {
  it.each([
    'fetch("/api/v2/settings")',
    'window["fetch"]("/api/v2/settings")',
    'const send = fetch; send("/api/v2/settings")',
    "new XMLHttpRequest()",
    'server.api.request("projects")',
    'const { mediaRequest: read } = api; read("media")',
    'import { apiRequest as read } from "../../api"; read(api, "settings")',
    'localStorage.setItem("edits", "lost")',
    'const storage = window["sessionStorage"]; storage.getItem("key")',
    'import * as Store from "effect/persistence/KeyValueStore";',
    'import * as HTTP from "effect/http/HttpClient"; HTTP.get("/settings")',
    'import { runPromise as start } from "effect/Effect"; button.onclick = start',
    'import { Effect as E } from "effect"; E.runPromise(effect)',
    'import { runFork as start } from "effect/Effect"; start(effect)',
    'import * as E from "effect/Effect"; const { runPromise: start } = E; start(effect)',
    'import * as A from "effect/reactivity/Atom"; A.runtime(layer)',
    'import { make as create } from "effect/reactivity/AtomRegistry"; create()',
    'import { ManagedRuntime as R } from "effect"; R.make(layer)',
    'import * as A from "effect/reactivity/Atom"; A.fn(() => effect)',
    'import { RegistryProvider as Provider } from "@effect/atom-solid";',
    'import * as E from "effect/Effect"; button.onclick = E.runPromise',
  ])("rejects bypass: %s", (source) => {
    expect(checkSource("features/example/controller.ts", source).length).toBeGreaterThan(0);
  });

  it("allows atom reads, workspace dispatch, pure helpers and native DOM mechanics", () => {
    expect(
      checkSource(
        "features/example/View.tsx",
        `
      import { useAtomValue } from "@effect/atom-solid";
      import * as Atom from "effect/reactivity/Atom";
      const state = useAtomValue(() => owner.state);
      const command = server.runtime.fn(() => effect);
      server.registry.set(command, undefined);
      server.registry.set(command, Atom.Interrupt);
      const abort = new AbortController();
      const focus = Promise.resolve().then(() => element.focus());
    `,
      ),
    ).toEqual([]);
  });

  it.each(Object.entries(adapters))(
    "allows only documented capabilities in %s",
    (path, capabilities) => {
      const samples = {
        http: 'fetch("native")',
        storage: 'localStorage.getItem("preferences")',
        persistence: 'import * as Store from "effect/persistence/KeyValueStore";',
        transport: 'import { createNativeHttpClientLayer as layer } from "../../api";',
        runtime: 'import * as Atom from "effect/reactivity/Atom"; Atom.runtime(layer)',
        command: 'import * as Atom from "effect/reactivity/Atom"; Atom.fn(() => effect)',
        execution: 'import { Effect } from "effect"; Effect.runPromise(effect)',
        provider: 'import { RegistryProvider } from "@effect/atom-solid";',
      };
      for (const [capability, sample] of Object.entries(samples))
        expect(checkSource(path, sample).length === 0).toBe(capabilities.includes(capability));
    },
  );

  it("audits the complete production source, including controllers", () => {
    expect(checkDirectory(fileURLToPath(new URL("../src", import.meta.url)))).toEqual([]);
  });
});
