import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createApiClient } from "../src/api";
import { createSettingsController } from "../src/features/settings/controller";
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

function controller(fetch: typeof globalThis.fetch) {
  vi.stubGlobal("localStorage", { getItem: () => null });
  return createSettingsController(
    createApiClient(
      { serverBaseUrl: "https://example.test", authentication: { type: "none" } },
      fetch,
    ),
  );
}
afterEach(() => vi.unstubAllGlobals());

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

  it("does not let an older settings load overwrite a newer revision", async () => {
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
    await state.loadServerSettings();
    release(Response.json(document));
    await older;
    expect(state.settingsRevision()).toBe(2);
    expect(state.runtimeSettings()?.exportLimit).toBe(4);
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
        Response.json({ revision: 2, settings: { ...settings, mcpEnabled: true } }),
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
    releasePut(Response.json({ revision: 2, settings: { ...settings, mcpEnabled: true } }));
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
          proposals: [{ id: "ep_first" }],
          proposalNextCursor: "ep_first",
        }),
      )
      .mockResolvedValueOnce(Response.json({ ...mcp, proposals: [{ id: "ep_second" }] }));
    const state = controller(fetch);
    await state.loadMCPSettings();
    await state.loadMCPSettings(undefined, state.mcpSettings()?.proposalNextCursor);

    expect(String(fetch.mock.calls[1][0])).toContain("proposalCursor=ep_first");
    expect(state.mcpSettings()?.proposals.map((proposal) => proposal.id)).toEqual([
      "ep_first",
      "ep_second",
    ]);
    expect(state.mcpSettings()?.proposalNextCursor).toBeUndefined();
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
});
