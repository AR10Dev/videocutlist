import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createApiClient } from "../src/api";
import { createServerState } from "../src/app/server";
import { createProjectToolsSession } from "../src/features/projects/import";
import type { Project } from "../src/generated/effect-api";

const media = {
  id: "m_" + "a".repeat(43),
  name: "movie",
  durationMs: 10000,
  sizeBytes: 1,
  container: "mp4",
  streams: {},
  etag: "1",
};
const project: Project = {
  id: "p_project00000001",
  name: "Project",
  revision: 2,
  schemaVersion: 2,
  items: [{ id: "i_" + "b".repeat(24), mediaId: media.id, segments: [], exportOptions: {} }],
  updatedAt: "2026-01-01T00:00:00Z",
};
const registries: AtomRegistry.AtomRegistry[] = [];
afterEach(() => {
  registries.splice(0).forEach((registry) => registry.dispose());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetch);
  const configuration = {
    serverBaseUrl: "https://example.test",
    authentication: { type: "none" as const },
  };
  const registry = AtomRegistry.make();
  registries.push(registry);
  const server = createServerState(createApiClient(configuration), registry, configuration);
  const workspaceIdentity = Atom.keepAlive(
    Atom.make({
      projectId: project.id,
      projectName: project.name,
      revision: project.revision,
      activeItemId: project.items[0].id as string | undefined,
      selectedMediaId: media.id as string | undefined,
      editVersion: 0,
      generation: 0,
      dirty: true,
      status: "",
    }),
  );
  const replace = vi.fn();
  const load = vi.fn();
  const imported = vi.fn();
  const status = vi.fn();
  const deps = {
    server,
    projectId: () => project.id,
    activeItemId: () => project.items[0].id,
    workspaceIdentity,
    selected: () => media,
    dirty: () => true,
    projects: {
      saveProjectEffect: (): Effect.Effect<Project | undefined, Error> => Effect.succeed(project),
      loadProjectEffect: (id: string) =>
        Effect.sync(() => {
          load(id);
        }),
      importProjectEffect: (document: unknown, confirmed: boolean) =>
        Effect.sync(() => {
          imported(document, confirmed);
        }),
    },
    editor: { updateTimeline: replace },
    addMediaToProject: vi.fn(),
    setStatus: status,
  };
  const session = createProjectToolsSession(deps, () => true);
  const done = () =>
    Effect.runPromise(AtomRegistry.getResult(registry, session.result, { suspendOnWaiting: true }));
  const file = (text: string, name = "cuts.json") =>
    Object.assign(new Blob([text]), { name, lastModified: 0 }) as File;
  return {
    fetch,
    deps,
    registry,
    session,
    done,
    file,
    replace,
    load,
    imported,
    status,
    edit: () =>
      registry.update(workspaceIdentity, (state) => ({
        ...state,
        editVersion: state.editVersion + 1,
      })),
  };
}

describe("cut-list import session", () => {
  it("imports project JSON through the composed restoration and selected-media legacy JSON into the editor", async () => {
    const s = setup();
    s.session.import(s.file(JSON.stringify(project)));
    await s.done();
    expect(s.imported).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 0, items: project.items }),
      true,
    );
    s.session.import(
      s.file(
        JSON.stringify({ mediaId: media.id, uiState: {}, segments: [{ startMs: 0, endMs: 1000 }] }),
      ),
    );
    await s.done();
    expect(s.replace).toHaveBeenCalledWith({ segments: [{ startMs: 0, endMs: 1000 }] });
  });
  it.each([
    "{}",
    "not json",
    JSON.stringify({ mediaId: "wrong", uiState: {}, segments: [] }),
    JSON.stringify({ mediaId: media.id, uiState: {}, segments: [{ startMs: 0, endMs: 20000 }] }),
    " ".repeat((1 << 20) + 1),
  ])("rejects invalid input without replacing a document", async (text) => {
    const s = setup();
    s.session.import(s.file(text));
    await expect(s.done()).rejects.toThrow();
    expect(s.replace).not.toHaveBeenCalled();
    expect(s.imported).not.toHaveBeenCalled();
    expect(s.status).toHaveBeenCalled();
  });
  it.each(["csv", "chapters"])(
    "saves before native %s import and reloads validated identity",
    async (format) => {
      const s = setup();
      const order: string[] = [];
      s.deps.projects.saveProjectEffect = () =>
        Effect.sync(() => {
          order.push("save");
          return project;
        });
      s.fetch.mockImplementation(async (input: RequestInfo | URL) => {
        order.push("import");
        expect(String(input)).toContain(`/interchange/${format}`);
        return Response.json(project);
      });
      s.session.import(s.file("text", `cuts.${format}`));
      await s.done();
      expect(order).toEqual(["save", "import"]);
      expect(s.load).toHaveBeenCalledWith(project.id);
    },
  );
  it("closing tools interrupts composed restoration resources", async () => {
    const s = setup();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = vi.fn();
    s.deps.projects.loadProjectEffect = () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          entered();
        }),
        () => Effect.never,
        () =>
          Effect.sync(() => {
            released();
          }),
      );
    s.fetch.mockResolvedValue(Response.json(project));
    s.session.import(s.file("text", "cuts.csv"));
    await started;
    s.session.close();
    await flush();
    expect(released).toHaveBeenCalledOnce();
    expect(s.load).not.toHaveBeenCalled();
  });
  it("rejects a context edit while saving before the native mutation", async () => {
    const s = setup();
    let resolve!: (project: Project) => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    s.deps.projects.saveProjectEffect = () =>
      Effect.promise(() => {
        entered();
        return new Promise<Project>((r) => {
          resolve = r;
        });
      });
    s.session.import(s.file("text", "cuts.csv"));
    await started;
    s.edit();
    resolve(project);
    await flush();
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.load).not.toHaveBeenCalled();
  });
  it("save failure prevents native import", async () => {
    const s = setup();
    const fetch = s.fetch;
    s.deps.projects.saveProjectEffect = () => Effect.fail(new Error("Save failed"));
    s.session.import(s.file("text", "cuts.csv"));
    await expect(s.done()).rejects.toThrow("Save failed");
    expect(fetch).not.toHaveBeenCalled();
    expect(s.load).not.toHaveBeenCalled();
  });
  it.each(["close", "edit", "supersede", "wrong identity"])(
    "rejects late native publication after %s",
    async (change) => {
      const s = setup();
      let resolve!: (response: Response) => void;
      let started!: () => void;
      const ready = new Promise<void>((r) => {
        started = r;
      });
      s.fetch.mockImplementation(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
            started();
          }),
      );
      s.session.import(s.file("text", "cuts.csv"));
      await ready;
      expect(resolve).toBeTypeOf("function");
      if (change === "close") s.session.close();
      if (change === "edit") s.edit();
      if (change === "supersede") {
        s.session.import(s.file("{}"));
        await expect(s.done()).rejects.toThrow();
      }
      resolve(
        Response.json({
          ...project,
          id: change === "wrong identity" ? "p_otherproject001" : project.id,
        }),
      );
      if (change === "edit") await flush();
      if (change === "wrong identity")
        await expect(s.done()).rejects.toThrow("Imported project response is invalid");
      await flush();
      expect(s.load).not.toHaveBeenCalled();
      expect(s.replace).not.toHaveBeenCalled();
    },
  );
});

describe("cut-list export session", () => {
  const browser = () => {
    const anchor = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: () => anchor });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    return { anchor, revoke };
  };
  it.each(["csv", "chapters"] as const)(
    "saves before %s export and publishes the command result",
    async (format) => {
      const s = setup();
      const b = browser();
      const order: string[] = [];
      s.deps.projects.saveProjectEffect = () =>
        Effect.sync(() => {
          order.push("save");
          return project;
        });
      s.fetch.mockImplementation(async (input) => {
        order.push("read");
        expect(String(input)).toContain(`/interchange/${format}`);
        return new Response("cut list");
      });
      s.session.export(format);
      await s.done();
      expect(order).toEqual(["save", "read"]);
      expect(b.anchor.click).toHaveBeenCalledOnce();
      expect(b.revoke).toHaveBeenCalledExactlyOnceWith("blob:export");
      expect(s.status).toHaveBeenCalledWith(
        `${format === "csv" ? "CSV" : "Chapters"} cut list downloaded.`,
      );
    },
  );
  it.each(["failure", "undefined", "edit"])("stops export after save %s", async (mode) => {
    const s = setup();
    const b = browser();
    s.deps.projects.saveProjectEffect = () =>
      mode === "failure"
        ? Effect.fail(new Error("Save failed"))
        : Effect.sync(() => {
            if (mode === "edit") s.edit();
            return mode === "undefined" ? undefined : project;
          });
    s.session.export("csv");
    if (mode === "edit") await flush();
    else
      await expect(s.done()).rejects.toThrow(
        mode === "failure" ? "Save failed" : "Save the project",
      );
    expect(s.fetch).not.toHaveBeenCalled();
    expect(b.anchor.click).not.toHaveBeenCalled();
  });
  it.each(["close", "edit", "supersede", "dispose"])(
    "prevents late download on %s and releases the reader",
    async (mode) => {
      const s = setup();
      const b = browser();
      let started!: () => void;
      const ready = new Promise<void>((r) => {
        started = r;
      });
      const cancelled = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        pull() {
          started();
        },
        cancel: cancelled,
      });
      s.fetch.mockResolvedValue(new Response(body));
      s.session.export("csv");
      await ready;
      await flush();
      if (mode === "close") s.session.close();
      if (mode === "dispose") s.registry.dispose();
      if (mode === "supersede") {
        s.session.import(s.file("{}"));
        await expect(s.done()).rejects.toThrow();
      }
      if (mode === "edit") s.edit();
      await flush();
      expect(body.locked).toBe(false);
      expect(cancelled).toHaveBeenCalledOnce();
      expect(b.anchor.click).not.toHaveBeenCalled();
      expect(b.revoke).not.toHaveBeenCalled();
      expect(s.status).not.toHaveBeenCalledWith("CSV cut list downloaded.");
    },
  );
  it("session close after click waits for browser handoff then releases the URL", async () => {
    const s = setup();
    const b = browser();
    vi.useFakeTimers();
    s.fetch.mockResolvedValue(new Response("text"));
    let clicked!: () => void;
    const ready = new Promise<void>((r) => {
      clicked = r;
    });
    b.anchor.click.mockImplementation(clicked);
    s.session.export("csv");
    await ready;
    s.session.close();
    await flush();
    expect(b.revoke).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(b.revoke).toHaveBeenCalledExactlyOnceWith("blob:export");
    expect(s.status).not.toHaveBeenCalledWith("CSV cut list downloaded.");
  });
});
