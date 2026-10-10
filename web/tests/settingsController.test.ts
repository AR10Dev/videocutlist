import type * as EffectApiTypes from "../src/generated/effect-api";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { Effect } from "effect";
import type * as Atom from "effect/reactivity/Atom";
import { createControllerTestRoot } from "./controllerTestEnvironment";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createSettingsController } from "../src/features/settings/controller";
import {
  browserPreferencesKey,
  defaultBrowserPreferences,
  validRuntimeSettingsInput,
} from "../src/features/settings/model";
import { memoryStorage } from "./memoryStorage";

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
} satisfies EffectApiTypes.SettingsResponse["settings"];
const document = {
  revision: 1,
  schemaVersion: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  pathsConstrained: false,
  roots: {},
  settings,
} satisfies EffectApiTypes.SettingsResponse;
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
} satisfies EffectApiTypes.MCPSettingsResponse;

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
function workspace(fetchImplementation: typeof globalThis.fetch, storage = memoryStorage()) {
  const root = createControllerTestRoot(
    ({ api, server, registry }) => {
      const state = createSettingsController(api, server);
      return { server, state, storage, registry };
    },
    {
      configuration: {
        serverBaseUrl: "https://example.test",
        authentication: { type: "none" },
      },
      storage,
      fetch: async (input, init?: RequestInit) => {
        const request = new Request(input, init);
        const body =
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await request.clone().text();
        // SAFETY: the generated client is configured with the fixed example.test origin in this test.
        const url = new URL(request.url);
        if (url.origin !== "https://example.test") throw new Error("Unexpected test API origin");
        return fetchImplementation(url.toString(), {
          method: request.method,
          headers: request.headers,
          body,
          signal: request.signal,
        });
      },
    },
  );
  const { server, state, registry } = root.value;
  cleanups.push(() => {
    try {
      state.dispose();
    } finally {
      root.dispose();
    }
  });
  testRegistries.set(state, registry);
  return { server, state, storage };
}
function controller(fetch: typeof globalThis.fetch) {
  return workspace(fetch).state;
}
function settled<A, E>(
  state: ReturnType<typeof createSettingsController>,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  // Tests await the native command result; production callers only dispatch.
  return Effect.runPromise(
    AtomRegistry.getResult(testRegistries.get(state)!, atom, { suspendOnWaiting: true }),
  ).catch(() => false);
}
const testRegistries = new WeakMap<
  ReturnType<typeof createSettingsController>,
  AtomRegistry.AtomRegistry
>();
function load(state: ReturnType<typeof createSettingsController>) {
  state.loadServerSettings();
  return settled(state, state.settingsLoad);
}
function save(
  state: ReturnType<typeof createSettingsController>,
  changes: Partial<typeof settings>,
  message: string,
) {
  state.saveRuntimeSettings(changes, message);
  return settled(state, state.settingsSave);
}
function rescan(state: ReturnType<typeof createSettingsController>) {
  state.rescanLibrary();
  return settled(state, state.rescan);
}
async function loadMCPSettings(
  state: ReturnType<typeof createSettingsController>,
  ...args: Parameters<typeof state.loadMCPSettings>
) {
  if (!state.loadMCPSettings(...args)) return false;
  return (await settled(state, state.mcpLoad)) !== false;
}
async function setMCPEnabled(
  state: ReturnType<typeof createSettingsController>,
  ...args: Parameters<typeof state.setMCPEnabled>
) {
  if (!state.setMCPEnabled(...args)) return false;
  return (await settled(state, state.mcpEnable)) !== false;
}
async function createMCPCredential(
  state: ReturnType<typeof createSettingsController>,
  ...args: Parameters<typeof state.createMCPCredential>
) {
  if (!state.createMCPCredential(...args)) return false;
  return (await settled(state, state.mcpMutation)) !== false;
}
async function revokeMCPCredential(
  state: ReturnType<typeof createSettingsController>,
  ...args: Parameters<typeof state.revokeMCPCredential>
) {
  if (!state.revokeMCPCredential(...args)) return false;
  return (await settled(state, state.mcpMutation)) !== false;
}
async function approveExportProposal(
  state: ReturnType<typeof createSettingsController>,
  ...args: Parameters<typeof state.approveExportProposal>
) {
  if (!state.approveExportProposal(...args)) return false;
  return (await settled(state, state.mcpMutation)) !== false;
}
function disposeWorkspaces() {
  let failed = false;
  let firstError: unknown;
  for (const dispose of cleanups.splice(0).reverse()) {
    try {
      dispose();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  try {
    vi.unstubAllGlobals();
  } catch (error) {
    if (!failed) firstError = error;
    failed = true;
  }
  if (failed) throw firstError;
}
afterEach(disposeWorkspaces);

describe("preview concurrency settings", () => {
  it("accepts the documented ceiling and rejects larger client updates", () => {
    expect(validRuntimeSettingsInput({ ...settings, previewGlobalLimit: 64 })).toBe(true);
    expect(validRuntimeSettingsInput({ ...settings, previewGlobalLimit: 65 })).toBe(false);
  });
});

describe("settings controller", () => {
  it("restores global descriptors after reverse teardown of multiple workspaces", () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    try {
      const first = workspace(vi.fn<typeof globalThis.fetch>());
      const firstFetch = globalThis.fetch;
      const second = workspace(vi.fn<typeof globalThis.fetch>());
      expect(globalThis.fetch).not.toBe(firstFetch);
      expect(first.storage).not.toBe(second.storage);
      expect(globalThis.localStorage).toBe(second.storage);
    } finally {
      disposeWorkspaces();
      expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(originalFetch);
      expect(Object.getOwnPropertyDescriptor(globalThis, "localStorage")).toEqual(originalStorage);
    }
  });

  it("updates persisted browser preferences without a server settings request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { server, state } = workspace(fetch);

    state.saveSettings({ appearance: "dracula", waveformVisible: false });

    await vi.waitFor(() =>
      expect(state.settings()).toMatchObject({ appearance: "dracula", waveformVisible: false }),
    );
    await vi.waitFor(() =>
      expect(server.registry.get(server.preferences.status).write).toBe("saved"),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resets all browser preferences, including the remembered destination, and reloads defaults", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const storage = memoryStorage();
    const { server, state } = workspace(fetch, storage);
    state.saveSettings({
      appearance: "dracula",
      cutStrategy: "precise_reencode",
      filenameTemplate: "custom-{segment}.{ext}",
      muted: true,
      waveformVisible: false,
      loopSelectedSegment: true,
      lastDestinationId: "archive",
    });
    await vi.waitFor(() =>
      expect(server.registry.get(server.preferences.value)).toMatchObject({
        appearance: "dracula",
        lastDestinationId: "archive",
      }),
    );
    await vi.waitFor(() =>
      expect(JSON.parse(storage.getItem(browserPreferencesKey) ?? "null").lastDestinationId).toBe(
        "archive",
      ),
    );

    await state.resetBrowserPreferences();
    await vi.waitFor(() => {
      expect(server.registry.get(server.preferences.value)).toEqual(defaultBrowserPreferences);
      expect(JSON.parse(storage.getItem(browserPreferencesKey) ?? "null")).toEqual(
        defaultBrowserPreferences,
      );
    });

    const reloaded = workspace(fetch, storage);
    await vi.waitFor(() =>
      expect(reloaded.server.registry.get(reloaded.server.preferences.status).initialized).toBe(
        true,
      ),
    );
    expect(reloaded.server.registry.get(reloaded.server.preferences.value)).toEqual(
      defaultBrowserPreferences,
    );
    expect(reloaded.server.registry.get(reloaded.server.preferences.value)).not.toHaveProperty(
      "lastDestinationId",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires complete mutable settings for GET and PUT", () => {
    expectTypeOf<
      EffectApiTypes.SettingsUpdate["settings"]["exportLimit"]
    >().toEqualTypeOf<number>();
    expectTypeOf<
      EffectApiTypes.SettingsUpdate["settings"]["previewGlobalLimit"]
    >().toEqualTypeOf<number>();
    expectTypeOf<
      EffectApiTypes.SettingsResponse["settings"]["mcpEnabled"]
    >().toEqualTypeOf<boolean>();
    const complete: EffectApiTypes.SettingsResponse["settings"] = settings;
    expect(complete.mcpEnabled).toBe(false);
    // @ts-expect-error GET responses must contain every mutable setting.
    const sparse: EffectApiTypes.SettingsResponse["settings"] = {};
    const { mcpEnabled: _mcpEnabled, ...withoutMCPEnabled } = settings;
    const incomplete: EffectApiTypes.SettingsUpdate = {
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
    await load(state);
    expect(await save(state, { exportLimit: 3 }, "Saved")).toBe(false);
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
    await load(state);
    for (const value of [0, 65, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await save(state, { exportLimit: value }, "Saved")).toBe(false);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await save(state, { exportLimit: 64 }, "Saved")).toBe(true);
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
    const older = load(state);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const newer = load(state);
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
    await load(state);
    const refresh = loadMCPSettings(state);
    expect(state.mcpLoading()).toBe(true);
    expect(await setMCPEnabled(state, true)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    release(Response.json(mcp));
    await refresh;
    expect(state.mcpSettings()?.enabled).toBe(false);
    expect(await setMCPEnabled(state, true)).toBe(true);
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
    await load(state);
    await loadMCPSettings(state);
    const toggle = setMCPEnabled(state, true);
    expect(state.settingsPending()).toBe(true);
    const refresh = loadMCPSettings(state);
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
    await loadMCPSettings(state);
    await loadMCPSettings(state, undefined, state.mcpSettings()?.proposalNextCursor);

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
    await loadMCPSettings(state);
    await loadMCPSettings(state, state.mcpSettings()?.nextCursor);
    expect(String(fetch.mock.calls[1][0])).toContain("cursor=c_000000000002");
    expect(state.mcpSettings()?.credentials.map((item) => item.id)).toEqual([
      "c_000000000002",
      "c_000000000003",
    ]);
    expect(state.mcpSettings()?.proposals.map((item) => item.id)).toEqual(["ep_000000000003"]);
    expect(state.mcpSettings()?.proposalNextCursor).toBe("ep_000000000003");
  });
  it("appends proposals while retaining credential data/cursor and authoritative drafts", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ...mcp,
          credentials: [credential("c_000000000001")],
          nextCursor: "credential-page",
          proposals: [proposal("ep_000000000001")],
          proposalNextCursor: "proposal-page",
        }),
      )
      .mockResolvedValueOnce(Response.json({ ...mcp, proposals: [proposal("ep_000000000002")] }));
    const { server, state } = workspace(fetch);
    await loadMCPSettings(state);
    state.updateMCPDraft("name", "Unsubmitted edit");
    await loadMCPSettings(state, undefined, "proposal-page");
    expect(state.mcpSettings()?.credentials.map((item) => item.id)).toEqual(["c_000000000001"]);
    expect(state.mcpSettings()?.nextCursor).toBe("credential-page");
    expect(state.mcpSettings()?.proposals).toHaveLength(2);
    expect(state.mcp.keepAlive).toBe(true);
    expect(server.registry.get(state.mcp).data).toEqual(state.mcpSettings());
    expect(state.mcpDraftValue().name).toBe("Unsubmitted edit");
  });

  it("guards duplicate creation, clears disclosure on disposal and resets cached results before refresh", async () => {
    let release!: (response: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { ...credential("c_000000000001"), secret: "transient-test-value" },
          { status: 201 },
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    const { server, state } = workspace(fetch);
    state.setSettingsOpen(true);
    const input = {
      name: "Demo",
      permissions: [],
      mediaScope: { kind: "all" as const },
      projectScope: { kind: "all" as const },
    };
    const creation = createMCPCredential(state, input);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(state.createMCPCredential(input)).toBe(false);
    const mutation = server.generatedApi.mutation("default", "createMCPCredential");
    expect(AsyncResult.isInitial(server.registry.get(mutation))).toBe(true);
    expect(state.revealedMCPSecret()).not.toBe("");
    expect(JSON.stringify(server.registry.get(state.mcpMutation))).not.toContain(
      "transient-test-value",
    );
    expect(JSON.stringify(server.registry.get(state.mcp))).not.toContain("transient-test-value");
    state.dispose();
    expect(server.registry.get(state.disclosure)).toBe("");
    release(Response.json(mcp));
    expect(await creation).toBe(false);
  });

  it.each(["create", "approve", "revoke"])(
    "keeps %s rejection safe and clears old errors on close",
    async (action) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        Response.json(
          {
            error: { code: "permission_denied", message: "private detail", requestId: "denied" },
          },
          { status: 403 },
        ),
      );
      const state = controller(fetch);
      state.setSettingsOpen(true);
      if (action === "create")
        await createMCPCredential(state, {
          name: "Demo",
          permissions: [],
          mediaScope: { kind: "all" },
          projectScope: { kind: "all" },
        });
      else if (action === "approve") await approveExportProposal(state, "ep_000000000001");
      else await revokeMCPCredential(state, "c_000000000001");
      expect(state.mcpStatus()).not.toBe("");
      expect(state.mcpStatus()).not.toContain("private detail");
      state.setSettingsOpen(false);
      state.setSettingsOpen(true);
      expect(state.mcpStatus()).toBe("");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

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
    await load(state);
    await load(state);
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
    expect(await loadMCPSettings(state)).toBe(true);
    expect(await loadMCPSettings(state)).toBe(false);
    expect(state.mcpSettings()?.credentials.map((item) => item.id)).toEqual(["c_000000000004"]);
    expect(state.mcpLoadError()).toContain("could not be refreshed");
    expect(state.mcpLoadError()).not.toContain("Internal detail");
    expect(await loadMCPSettings(state)).toBe(true);
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
          {
            error: {
              code: "gateway_timeout_unfamiliar",
              message: "Try again.",
              requestId: "r-rescan-timeout",
            },
          },
          { status: 500 },
        ),
      )
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

    await rescan(state);
    expect(fetch).toHaveBeenCalledTimes(1);
    await rescan(state);
    await rescan(state);
    await rescan(state);

    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Idempotency-Key")),
    ).toEqual(["scan-key-1", "scan-key-1", "scan-key-1", "scan-key-2"]);
    expect(fetch.mock.calls.map(([, init]) => init?.body)).toEqual(["", "", "", ""]);
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith("/settings/media/refresh"))).toBe(
      true,
    );
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

    await rescan(state);
    await rescan(state);

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
    await loadMCPSettings(state);
    state.setSettingsOpen(true);
    await revokeMCPCredential(state, "c_000000000001");
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
    const creation = createMCPCredential(state, {
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
    const creation = createMCPCredential(state, {
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
    const creation = createMCPCredential(state, {
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
    const loading = load(state);
    expect(state.serverSettingsLoading()).toBe(true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    state.dispose();
    release(Response.json(document));
    await loading;
    expect(state.runtimeSettings()).toBeUndefined();
  });
  it("publishes returned settings/revision and retains them without view subscribers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      Response.json(
        init?.method === "PUT"
          ? { ...document, revision: 7, settings: { ...settings, exportLimit: 5 } }
          : { ...document, roots: { movies: { state: "ready" } } },
      ),
    );
    const { server, state } = workspace(fetch);
    await load(state);
    expect(await save(state, { exportLimit: 3 }, "Saved")).toBe(true);
    expect(state.settingsRevision()).toBe(7);
    expect(state.runtimeSettings()?.exportLimit).toBe(5);
    expect(state.libraryRoots()).toEqual([{ alias: "movies", state: "ready" }]);
    const unsubscribe = server.registry.subscribe(state.administrator, () => {});
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.registry.get(state.administrator).revision).toBe(7);
    expect(state.administrator.keepAlive).toBe(true);
  });

  it("does not publish a late save after disposal or issue a reload while saving", async () => {
    let release!: (response: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(document))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    const { state } = workspace(fetch);
    await load(state);
    const saving = save(state, { exportLimit: 3 }, "Saved");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    state.loadServerSettings();
    expect(fetch).toHaveBeenCalledTimes(2);
    state.dispose();
    release(Response.json({ ...document, revision: 7, settings: { ...settings, exportLimit: 3 } }));
    expect(await saving).toBe(false);
    expect(state.settingsRevision()).toBe(1);
    expect(state.runtimeSettings()?.exportLimit).toBe(2);
  });

  it("starts both open-time loads concurrently through the workspace", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    const state = controller(fetch);
    state.openSettings();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(state.serverSettingsLoading()).toBe(true);
    expect(state.mcpLoading()).toBe(true);
    fetch.mock.calls.forEach(([url], index) =>
      pending[index](Response.json(String(url).endsWith("/settings/mcp") ? mcp : document)),
    );
    await vi.waitFor(() => {
      expect(state.runtimeSettings()).toEqual(settings);
      expect(state.mcpSettings()?.endpoint).toBe("https://example.test/mcp");
    });
  });
  it.each(["invalid_settings", "deployment_settings_read_only"])(
    "keeps server rejection %s safe and actionable",
    async (code) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(Response.json(document))
        .mockResolvedValueOnce(
          Response.json(
            { error: { code, message: "sensitive server detail", requestId: "reject" } },
            { status: 400 },
          ),
        );
      const { server, state } = workspace(fetch);
      await load(state);
      expect(await save(state, { exportLimit: 3 }, "Saved")).toBe(false);
      expect(AsyncResult.isFailure(server.registry.get(state.settingsSave))).toBe(true);
      expect(state.serverSettingsStatus()).toContain("deployment settings are read-only");
      expect(state.serverSettingsStatus()).not.toContain("sensitive");
      expect(state.settingsRevision()).toBe(1);
    },
  );

  it("rejects a preview window shorter than before plus after without a mutation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json(document));
    const state = controller(fetch);
    await load(state);
    expect(await save(state, { previewMaxMs: 1999 }, "Saved")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.serverSettingsStatus()).toContain("before + after");
  });
});
