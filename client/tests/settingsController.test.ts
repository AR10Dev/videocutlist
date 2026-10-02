import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createApiClient } from "../src/api";
import { createServerState } from "../src/features/app/server";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createSettingsController } from "../src/features/settings/controller";
import { validRuntimeSettingsInput } from "../src/features/settings/model";
import type { components } from "../src/generated/api";

const settings = {
  destinations: [{ id: "download", label: "Downloads", kind: "download", retention: "24h" }],
  exportLimit: 2,
  cacheMaxBytes: 1_000_000,
  previewGlobalLimit: 2,
  previewBeforeMs: 1000,
  previewAfterMs: 1000,
  previewMaxMs: 5000,
  previewGridMs: 1000,
  mediaMaxFiles: 100,
  mediaMaxDepth: 4,
  mcpEnabled: false,
} satisfies components["schemas"]["RuntimeSettings"];
const document = {
  revision: 1,
  schemaVersion: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  pathsConstrained: false,
  roots: {},
  settings,
} satisfies components["schemas"]["SettingsResponse"];
const mcp = {
  enabled: false,
  endpoint: "/mcp",
  authentication: "Bearer token",
  remoteAccessGuidance: "Use HTTPS for remote access.",
  clientCompatibility: "Streamable HTTP bearer-token clients only.",
  permissions: [],
  roots: [],
  credentials: [],
  proposals: [],
} satisfies components["schemas"]["MCPSettingsResponse"];

const credential = (id: string) => ({
  id,
  tokenIdentifier: "token-id",
  name: "Test key",
  permissions: ["media:read"],
  mediaScope: { kind: "all" as const },
  projectScope: { kind: "all" as const },
  unattendedExports: false,
  createdAt: "2026-01-01T00:00:00Z",
  status: "active" as const,
});
const proposal = (id: string) => ({
  id,
  credentialId: "c_000000000001",
  projectRevision: 1,
  snapshots: [],
  findings: [],
  allowed: true,
  requiresReencoding: false,
  accuracy: "frame_exact" as const,
  destinationId: "download",
  expiresAt: "2026-01-02T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
});

const cleanups: Array<() => void> = [];
function workspace(fetch: typeof globalThis.fetch) {
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.clone().text();
    // SAFETY: the generated client is configured with the fixed example.test origin in this test.
    return fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body,
      signal: request.signal,
    });
  });
  const configuration = {
    serverBaseUrl: "https://example.test",
    authentication: { type: "none" as const },
  };
  const api = createApiClient(configuration, fetch);
  const server = createServerState(api, AtomRegistry.make(), configuration);
  const state = createSettingsController(api, server);
  cleanups.push(state.dispose);
  return { server, state };
}
function controller(fetch: typeof globalThis.fetch) {
  return workspace(fetch).state;
}
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  vi.unstubAllGlobals();
});

describe("preview concurrency settings", () => {
  it("accepts the documented ceiling and rejects larger client updates", () => {
    expect(validRuntimeSettingsInput({ ...settings, previewGlobalLimit: 64 })).toBe(true);
    expect(validRuntimeSettingsInput({ ...settings, previewGlobalLimit: 65 })).toBe(false);
  });
});

describe("settings controller", () => {
  it("requires complete mutable settings for GET and PUT", () => {
    expectTypeOf<
      components["schemas"]["SettingsUpdate"]["settings"]["exportLimit"]
    >().toEqualTypeOf<number>();
    expectTypeOf<
      components["schemas"]["SettingsUpdate"]["settings"]["previewGlobalLimit"]
    >().toEqualTypeOf<number>();
    expectTypeOf<components["schemas"]["RuntimeSettings"]["mcpEnabled"]>().toEqualTypeOf<boolean>();
    const complete: components["schemas"]["RuntimeSettings"] = settings;
    expect(complete.mcpEnabled).toBe(false);
    // @ts-expect-error GET responses must contain every mutable setting.
    const sparse: components["schemas"]["RuntimeSettings"] = {};
    const { mcpEnabled: _mcpEnabled, ...withoutMCPEnabled } = settings;
    const incomplete: components["schemas"]["SettingsUpdate"] = {
      revision: 1,
      // @ts-expect-error Complete PUTs must include MCP enablement.
      settings: withoutMCPEnabled,
    };
    expect(sparse).toEqual({});
    expect(incomplete.revision).toBe(1);
  });
  it("uses the displayed revision and reports conflicts instead of silently rebasing changes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init): Promise<Response> =>
      init?.method === "PUT"
        ? Response.json(
            { error: { code: "settings_revision_conflict", message: "Changed", requestId: "r1" } },
            { status: 409 },
          )
        : Response.json({ ...document, revision: fetch.mock.calls.length }),
    );
    const state = controller(fetch);
    await state.loadServerSettings();
    expect(await state.saveRuntimeSettings({ exportLimit: 3 }, "Saved")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toMatchObject({
      revision: 1,
      settings: { exportLimit: 3 },
    });
    expect(state.runtimeSettings()?.exportLimit).toBe(2);
    expect(state.serverSettingsStatus()).toContain("Settings changed; reload");
  });

  it("rejects invalid limits without PUT and accepts the 64-worker ceiling", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      Response.json(
        init?.method === "PUT"
          ? { ...document, ...JSON.parse(String(init.body)), revision: 2 }
          : document,
      ),
    );
    const state = controller(fetch);
    await state.loadServerSettings();
    for (const value of [0, 65, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await state.saveRuntimeSettings({ exportLimit: value }, "Saved")).toBe(false);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await state.saveRuntimeSettings({ exportLimit: 64 }, "Saved")).toBe(true);
    expect(state.runtimeSettings()?.exportLimit).toBe(64);
  });

  it("reuses the in-flight generated settings query", async () => {
    let release!: (response: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(
        Response.json({ ...document, revision: 2, settings: { ...settings, exportLimit: 4 } }),
      );
    const state = controller(fetch);
    const older = state.loadServerSettings();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const newer = state.loadServerSettings();
    release(Response.json(document));
    await Promise.all([older, newer]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.settingsRevision()).toBe(1);
    expect(state.runtimeSettings()?.exportLimit).toBe(2);
  });

  it("does not let an MCP refresh race an enable toggle", async () => {
    let release!: (response: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(document))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(
        Response.json({ ...document, revision: 2, settings: { ...settings, mcpEnabled: true } }),
      );
    const state = controller(fetch);
    await state.loadServerSettings();
    const refresh = state.loadMCPSettings();
    expect(state.mcpLoading()).toBe(true);
    expect(await state.setMCPEnabled(true)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    release(Response.json(mcp));
    await refresh;
    expect(state.mcpSettings()?.enabled).toBe(false);
    expect(await state.setMCPEnabled(true)).toBe(true);
    expect(state.mcpSettings()?.enabled).toBe(true);
  });

  it("does not let a reverse-order MCP refresh overwrite an enable toggle", async () => {
    let releasePut!: (response: Response) => void;
    let releaseRefresh: ((response: Response) => void) | undefined;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(document))
      .mockResolvedValueOnce(Response.json(mcp))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releasePut = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRefresh = resolve;
          }),
      );
    const state = controller(fetch);
    await state.loadServerSettings();
    await state.loadMCPSettings();
    const toggle = state.setMCPEnabled(true);
    expect(state.settingsPending()).toBe(true);
    const refresh = state.loadMCPSettings();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    releasePut(
      Response.json({ ...document, revision: 2, settings: { ...settings, mcpEnabled: true } }),
    );
    expect(await toggle).toBe(true);
    releaseRefresh?.(Response.json(mcp));
    expect(await refresh).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(state.mcpSettings()?.enabled).toBe(true);
  });

  it("appends proposal pages without losing older pending proposals", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ...mcp,
          proposals: [proposal("ep_000000000001")],
          proposalNextCursor: "ep_000000000001",
        }),
      )
      .mockResolvedValueOnce(Response.json({ ...mcp, proposals: [proposal("ep_000000000002")] }));
    const state = controller(fetch);
    await state.loadMCPSettings();
    await state.loadMCPSettings(undefined, state.mcpSettings()?.proposalNextCursor);

    expect(String(fetch.mock.calls[1][0])).toContain("proposalCursor=ep_000000000001");
    expect(state.mcpSettings()?.proposals.map((proposal) => proposal.id)).toEqual([
      "ep_000000000001",
      "ep_000000000002",
    ]);
    expect(state.mcpSettings()?.proposalNextCursor).toBeUndefined();
  });
  it("appends credential pages without discarding previously loaded proposals", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ...mcp,
          credentials: [credential("c_000000000002")],
          nextCursor: "c_000000000002",
          proposals: [proposal("ep_000000000003")],
          proposalNextCursor: "ep_000000000003",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ...mcp,
          credentials: [credential("c_000000000003")],
        }),
      );
    const state = controller(fetch);
    await state.loadMCPSettings();
    await state.loadMCPSettings(state.mcpSettings()?.nextCursor);
    expect(String(fetch.mock.calls[1][0])).toContain("cursor=c_000000000002");
    expect(state.mcpSettings()?.credentials.map((item) => item.id)).toEqual([
      "c_000000000002",
      "c_000000000003",
    ]);
    expect(state.mcpSettings()?.proposals.map((item) => item.id)).toEqual(["ep_000000000003"]);
    expect(state.mcpSettings()?.proposalNextCursor).toBe("ep_000000000003");
  });
  it("distinguishes CORS denial from administrator authorization and offers no stale settings", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(document))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "origin_forbidden",
              message: "Request origin is not allowed.",
              requestId: "r2",
            },
          },
          { status: 403 },
        ),
      );
    const state = controller(fetch);
    await state.loadServerSettings();
    await state.loadServerSettings();
    expect(state.serverSettingsStatus()).toContain("origin");
    expect(state.runtimeSettings()).toBeUndefined();
  });
  it("retains the last MCP page when refresh fails, then clears the error on recovery", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ ...mcp, credentials: [credential("c_000000000004")] }))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "permission_denied", message: "Internal detail", requestId: "r3" } },
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ ...mcp, credentials: [credential("c_000000000005")] }),
      );
    const state = controller(fetch);
    expect(await state.loadMCPSettings()).toBe(true);
    expect(await state.loadMCPSettings()).toBe(false);
    expect(state.mcpSettings()?.credentials.map((item) => item.id)).toEqual(["c_000000000004"]);
    expect(state.mcpLoadError()).toContain("could not be refreshed");
    expect(state.mcpLoadError()).not.toContain("Internal detail");
    expect(await state.loadMCPSettings()).toBe(true);
    expect(state.mcpSettings()?.credentials.map((item) => item.id)).toEqual(["c_000000000005"]);
    expect(state.mcpLoadError()).toBe("");
  });

  it("redelivers an uncertain media refresh only on explicit action with the same key", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn().mockReturnValueOnce("scan-key-1").mockReturnValueOnce("scan-key-2"),
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(
        Response.json(
          { id: "j_000000000001", state: "queued", progress: 0, indexed: 0 },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { id: "j_000000000002", state: "queued", progress: 0, indexed: 0 },
          { status: 202 },
        ),
      );
    const state = controller(fetch);

    await state.rescanLibrary();
    expect(fetch).toHaveBeenCalledTimes(1);
    await state.rescanLibrary();
    await state.rescanLibrary();

    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Idempotency-Key")),
    ).toEqual(["scan-key-1", "scan-key-1", "scan-key-2"]);
  });

  it("uses a fresh key after a definite media-refresh rejection", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn().mockReturnValueOnce("scan-key-1").mockReturnValueOnce("scan-key-2"),
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "idempotency_conflict",
              message: "Key was used for another command.",
              requestId: "r4",
            },
          },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { id: "j_000000000003", state: "queued", progress: 0, indexed: 0 },
          { status: 202 },
        ),
      );
    const state = controller(fetch);

    await state.rescanLibrary();
    await state.rescanLibrary();

    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Idempotency-Key")),
    ).toEqual(["scan-key-1", "scan-key-2"]);
  });

  it("reports refresh failure after revocation without suggesting a second revoke", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(mcp))
      .mockResolvedValueOnce(Response.json(credential("c_000000000001")))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "permission_denied", message: "Unavailable", requestId: "r4" } },
          { status: 403 },
        ),
      );
    const state = controller(fetch);
    await state.loadMCPSettings();
    await state.revokeMCPCredential("c_000000000001");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(state.mcpStatus()).toBe("MCP credential revoked.");
    expect(state.mcpLoadError()).toContain("could not be refreshed");
    expect(state.mcpSettings()?.credentials).toEqual([]);
  });

  it("never rediscloses a credential secret after its disclosure session closes", async () => {
    let releaseRefresh!: (response: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ ...credential("c_000000000001"), secret: "once-only" }, { status: 201 }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRefresh = resolve;
          }),
      );
    const { server, state } = workspace(fetch);
    const createCredential = server.generatedApi!.mutation("default", "createMCPCredential");
    cleanups.push(server.registry.mount(createCredential));
    state.setSettingsOpen(true);
    const creation = state.createMCPCredential({
      name: "Demo",
      permissions: [],
      mediaScope: { kind: "all" },
      projectScope: { kind: "all" },
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[0][0]).toContain("/settings/mcp/credentials");
    expect(fetch.mock.calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      name: "Demo",
      permissions: [],
      mediaScope: { kind: "all" },
      projectScope: { kind: "all" },
    });
    expect(state.mcpPending()).toBe(true);
    expect(state.revealedMCPSecret()).toBe("once-only");
    state.setSettingsOpen(false);
    state.setSettingsOpen(true);
    releaseRefresh(Response.json(mcp));
    expect(await creation).toBe(true);
    expect(state.revealedMCPSecret()).toBe("");
    expect(AsyncResult.isInitial(server.registry.get(createCredential))).toBe(true);
    expect(JSON.stringify(server.registry.get(createCredential))).not.toContain("once-only");
    expect(state.mcpStatus()).toContain("disclosure was dismissed");
    expect(state.mcpSettings()?.credentials).toEqual([]);
  });

  it("discards a credential response that arrives after closing settings", async () => {
    let releaseCreate!: (response: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseCreate = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json(mcp));
    const { server, state } = workspace(fetch);
    const createCredential = server.generatedApi!.mutation("default", "createMCPCredential");
    cleanups.push(server.registry.mount(createCredential));
    state.setSettingsOpen(true);
    const creation = state.createMCPCredential({
      name: "Demo",
      permissions: [],
      mediaScope: { kind: "all" },
      projectScope: { kind: "all" },
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    state.setSettingsOpen(false);
    releaseCreate(
      Response.json(
        { ...credential("c_000000000001"), secret: "never-show-late" },
        { status: 201 },
      ),
    );

    expect(await creation).toBe(true);
    expect(state.revealedMCPSecret()).toBe("");
    expect(state.mcpStatus()).toBe("");
    expect(JSON.stringify(state.settings())).not.toContain("never-show-late");
    expect(AsyncResult.isInitial(server.registry.get(createCredential))).toBe(true);
    expect(JSON.stringify(server.registry.get(createCredential))).not.toContain("never-show-late");
  });

  it("resets the actual credential mutation result when controller disposal interrupts it", async () => {
    let releaseCreate!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () => new Promise((resolve) => (releaseCreate = resolve)),
    );
    const { server, state } = workspace(fetch);
    const createCredential = server.generatedApi!.mutation("default", "createMCPCredential");
    cleanups.push(server.registry.mount(createCredential));
    state.setSettingsOpen(true);
    const creation = state.createMCPCredential({
      name: "Demo",
      permissions: [],
      mediaScope: { kind: "all" },
      projectScope: { kind: "all" },
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    state.dispose();
    releaseCreate(
      Response.json(
        { ...credential("c_000000000001"), secret: "interrupted-secret" },
        { status: 201 },
      ),
    );
    expect(await creation).toBe(false);
    await vi.waitFor(() =>
      expect(AsyncResult.isInitial(server.registry.get(createCredential))).toBe(true),
    );
    expect(JSON.stringify(server.registry.get(createCredential))).not.toContain(
      "interrupted-secret",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("interrupts in-flight commands on disposal without republishing late settings", async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const state = controller(fetch);
    const loading = state.loadServerSettings();
    expect(state.serverSettingsLoading()).toBe(true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    state.dispose();
    release(Response.json(document));
    await loading;
    expect(state.runtimeSettings()).toBeUndefined();
  });
});
