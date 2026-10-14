import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createApiClient } from "../src/api";
import { createServerState } from "../src/app/server";
import { createProjectToolsSession } from "../src/features/projects/import";
import type { Project, ProjectImportResult } from "../src/generated/effect-api";

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
const legacySegments = [{ id: "s_imported", startMs: 100, endMs: 1000, label: "Imported" }];
const legacyResult: ProjectImportResult = {
  sourceFormat: "legacy",
  mediaId: media.id,
  document: {
    revision: 0,
    schemaVersion: 2,
    name: "Ignored canonical name",
    items: [
      {
        id: "i_" + "c".repeat(24),
        mediaId: media.id,
        segments: legacySegments,
        editorState: { playheadMs: 200, zoom: 2, muted: true },
        exportOptions: { mode: "separate" },
      },
    ],
  },
};
const v2Result: ProjectImportResult = {
  sourceFormat: "v2",
  document: { revision: 0, schemaVersion: 2, name: "Server v2", items: project.items },
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
const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};
function setup(confirmDiscard: () => boolean = () => true) {
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
  const session = createProjectToolsSession(deps, confirmDiscard);
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
    confirmDiscard,
    edit: () =>
      registry.update(workspaceIdentity, (state) => ({
        ...state,
        editVersion: state.editVersion + 1,
      })),
  };
}

describe("cut-list import session", () => {
  it("sends a bounded legacy file through the generated import operation and stages only selected-media segments", async () => {
    const s = setup();
    const content = JSON.stringify({ mediaId: media.id, uiState: { ignored: true }, segments: [] });
    s.fetch.mockResolvedValue(Response.json(legacyResult));
    const save = vi.spyOn(s.deps.projects, "saveProjectEffect");
    s.session.import(s.file(content));
    await s.done();

    const [url, init] = s.fetch.mock.calls[0];
    expect(String(url)).toContain("/api/v2/projects/import");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ content });
    expect(s.replace).toHaveBeenCalledWith({ segments: legacySegments });
    expect(s.deps.addMediaToProject).toHaveBeenCalledOnce();
    expect(s.imported).not.toHaveBeenCalled();
    expect(s.load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(s.registry.get(s.deps.workspaceIdentity)).toMatchObject({
      projectId: project.id,
      revision: project.revision,
      dirty: true,
    });
  });
  it("does not apply a legacy result for a different selected media", async () => {
    const s = setup();
    s.fetch.mockResolvedValue(
      Response.json({
        ...legacyResult,
        mediaId: "m_" + "z".repeat(43),
        document: {
          ...legacyResult.document,
          items: [{ ...legacyResult.document.items[0], mediaId: "m_" + "z".repeat(43) }],
        },
      }),
    );
    s.session.import(s.file("legacy project file"));
    await expect(s.done()).rejects.toThrow("Select the cut list's media before importing.");
    expect(s.replace).not.toHaveBeenCalled();
    expect(s.deps.addMediaToProject).not.toHaveBeenCalled();
    expect(s.imported).not.toHaveBeenCalled();
  });
  it("keeps a declined v2 import staged locally", async () => {
    const confirm = vi.fn(() => false);
    const s = setup(confirm);
    s.fetch.mockResolvedValue(Response.json(v2Result));
    s.session.import(s.file("v2 project file"));
    await s.done();
    expect(confirm).toHaveBeenCalledOnce();
    expect(s.imported).toHaveBeenCalledWith(v2Result.document, false);
    expect(s.replace).not.toHaveBeenCalled();
    expect(s.deps.addMediaToProject).not.toHaveBeenCalled();
    expect(s.registry.get(s.deps.workspaceIdentity)).toMatchObject({
      projectId: project.id,
      revision: project.revision,
      dirty: true,
    });
  });
  it("stages an accepted v2 import locally without saving it", async () => {
    const s = setup();
    s.fetch.mockResolvedValue(Response.json(v2Result));
    const save = vi.spyOn(s.deps.projects, "saveProjectEffect");
    s.session.import(s.file("v2 project file"));
    await s.done();
    expect(s.imported).toHaveBeenCalledWith(v2Result.document, true);
    expect(save).not.toHaveBeenCalled();
    expect(s.replace).not.toHaveBeenCalled();
    expect(s.fetch).toHaveBeenCalledOnce();
  });
  it("rejects runtime-invalid generated responses without applying them", async () => {
    const s = setup();
    s.fetch.mockResolvedValue(
      Response.json({
        ...legacyResult,
        document: {
          ...legacyResult.document,
          items: [{ ...legacyResult.document.items[0], segments: [{ startMs: 10, endMs: 0 }] }],
        },
      }),
    );
    s.session.import(s.file("legacy project file"));
    await expect(s.done()).rejects.toThrow();
    expect(s.replace).not.toHaveBeenCalled();
    expect(s.deps.addMediaToProject).not.toHaveBeenCalled();
    expect(s.imported).not.toHaveBeenCalled();
  });
  it.each([
    [400, "invalid_project_import"],
    [400, "media_unavailable"],
    [413, "project_import_too_large"],
  ])("surfaces server import rejection %s %s without local changes", async (status, code) => {
    const s = setup();
    s.fetch.mockResolvedValue(
      Response.json(
        { error: { code, message: "Project import rejected.", requestId: "r-import" } },
        { status },
      ),
    );
    s.session.import(s.file("project file"));
    await expect(s.done()).rejects.toThrow();
    expect(s.fetch).toHaveBeenCalledOnce();
    expect(s.replace).not.toHaveBeenCalled();
    expect(s.deps.addMediaToProject).not.toHaveBeenCalled();
    expect(s.imported).not.toHaveBeenCalled();
  });
  it("rejects a file whose advertised size is small but streamed bytes exceed the browser cap", async () => {
    const s = setup();
    const oversized = new Blob(["x".repeat((1 << 20) + 1)]);
    Object.defineProperty(oversized, "size", { value: 0 });
    s.session.import(Object.assign(oversized, { name: "cuts.json" }) as File);
    await expect(s.done()).rejects.toThrow("Cut list exceeds the 1 MiB limit.");
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.replace).not.toHaveBeenCalled();
    expect(s.imported).not.toHaveBeenCalled();
  });
  it.each(["close", "edit", "supersede"])(
    "aborts and ignores a late generated import response after %s",
    async (change) => {
      const s = setup();
      const first = deferred<Response>();
      const second = deferred<Response>();
      const firstStarted = deferred<void>();
      const secondStarted = deferred<void>();
      const signals: (AbortSignal | null | undefined)[] = [];
      let calls = 0;
      s.fetch.mockImplementation((_input, init) => {
        signals.push(init?.signal);
        calls++;
        if (calls === 1) {
          firstStarted.resolve();
          return first.promise;
        }
        secondStarted.resolve();
        return second.promise;
      });
      s.session.import(s.file("first import"));
      await firstStarted.promise;
      if (change === "close") s.session.close();
      if (change === "edit") s.edit();
      if (change === "supersede") {
        s.session.import(s.file("second import"));
        await secondStarted.promise;
        second.resolve(
          Response.json({
            ...legacyResult,
            document: {
              ...legacyResult.document,
              items: [
                { ...legacyResult.document.items[0], segments: [{ startMs: 0, endMs: 500 }] },
              ],
            },
          }),
        );
        await s.done();
      }
      expect(signals[0]?.aborted).toBe(true);
      first.resolve(Response.json(legacyResult));
      await flush();
      if (change === "supersede")
        expect(s.replace).toHaveBeenCalledExactlyOnceWith({
          segments: [{ startMs: 0, endMs: 500 }],
        });
      else {
        expect(s.replace).not.toHaveBeenCalled();
        expect(s.deps.addMediaToProject).not.toHaveBeenCalled();
      }
    },
  );
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
        s.session.import(s.file("x".repeat((1 << 20) + 1)));
        await expect(s.done()).rejects.toThrow("Cut list exceeds the 1 MiB limit.");
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
