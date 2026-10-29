import { Effect } from "effect";
import * as Atom from "effect/reactivity/Atom";
import type { ProjectPage } from "../../generated/effect-api";
import { readServerAtom, type ServerState } from "../../app/server";

/** Accumulated pages belong to one open browser session, not the HTTP cache. */
export function createProjectBrowser(server: ServerState) {
  const { registry } = server;
  const empty: ProjectPage = { items: [], nextCursor: null };
  const page = Atom.make<ProjectPage>(empty);
  const load = server.runtime.fn((cursor: string | undefined) =>
    Effect.gen(function* () {
      const resource = server.projectPage({
        limit: 50,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      registry.refresh(resource);
      const result = yield* readServerAtom(server, resource);
      registry.update(page, (previous) => ({
        items: cursor === undefined ? result.items : [...previous.items, ...result.items],
        nextCursor: result.nextCursor,
      }));
    }).pipe(
      Effect.mapError(() => new Error("Saved projects could not be loaded. Try Refresh projects.")),
    ),
  );
  let release: (() => void) | undefined;
  return {
    page,
    result: load,
    open() {
      if (release) return;
      const releasePage = registry.mount(page);
      const releaseLoad = registry.mount(load);
      release = () => {
        releaseLoad();
        releasePage();
      };
      registry.set(page, empty);
      registry.set(load, undefined);
    },
    refresh() {
      if (!release) return;
      registry.set(load, Atom.Interrupt);
      registry.set(page, empty);
      registry.set(load, undefined);
    },
    loadMore() {
      if (!release || registry.get(load).waiting) return;
      const cursor = registry.get(page).nextCursor;
      if (cursor !== null) registry.set(load, cursor);
    },
    close() {
      if (!release) return;
      registry.set(load, Atom.Interrupt);
      registry.set(load, Atom.Reset);
      registry.set(page, empty);
      release();
      release = undefined;
    },
  };
}
