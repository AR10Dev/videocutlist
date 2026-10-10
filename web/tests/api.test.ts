import { runEffect } from "./runEffect";
import { Cause, Effect, Exit } from "effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as HttpClient from "effect/http/HttpClient";
import { describe, expect, it, vi } from "vitest";
import {
  apiErrorCode,
  apiErrorEnvelope,
  authenticationRequiredEvent,
  createApiClient,
  createNativeHttpClientLayer,
  MAX_INTERCHANGE_FILE_BYTES,
  readApiError,
  uncertainCommandFailure,
  validInterchangeFileSize,
} from "../src/api";
import { createServerState, readServerAtom } from "../src/features/app/server";

describe("client API boundary", () => {
  it("extracts nested error codes and validates public error envelopes", () => {
    const envelope = { code: "revision_conflict", message: "Stale", requestId: "r-1" };
    expect(apiErrorCode({ cause: { error: envelope } })).toBe("revision_conflict");
    expect(apiErrorEnvelope({ error: envelope })).toEqual(envelope);
    expect(apiErrorEnvelope({ error: { ...envelope, requestId: 1 } })).toBeUndefined();
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(apiErrorCode(cyclic)).toBeUndefined();
  });
  it("preserves public failures through a generated resource operation", async () => {
    const originalFetch = globalThis.fetch;
    const publicError = {
      code: "not_found",
      message: "Project not found.",
      requestId: "r-not-found",
    };
    globalThis.fetch = async () => Response.json({ error: publicError }, { status: 404 });
    const configuration = {
      serverBaseUrl: "https://example.test",
      authentication: { type: "none" as const },
    };
    const api = createApiClient(configuration);
    const registry = AtomRegistry.make();
    const server = createServerState(api, registry, configuration);
    try {
      const result = await Effect.runPromiseExit(
        readServerAtom(server, server.project(`p_${"c".repeat(12)}`)),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.squash(result.cause)).toMatchObject({ error: publicError });
    } finally {
      registry.dispose();
      globalThis.fetch = originalFetch;
    }
  });
  it("preserves error codes, public messages, and request IDs, with safe malformed-response fallbacks", async () => {
    const error = {
      code: "origin_forbidden",
      message: "Request origin is not allowed.",
      requestId: "r-1",
    };
    expect(await readApiError(Response.json({ error }, { status: 403 }))).toEqual(error);
    for (const body of [
      "<html>proxy failure</html>",
      JSON.stringify({ error: { code: 409, message: "internal path", requestId: null } }),
    ]) {
      expect(
        await readApiError(
          new Response(body, { status: 500, headers: { "X-Request-ID": "r-2" } }),
          "Try again.",
        ),
      ).toEqual({ code: "http_error", message: "Try again.", requestId: "r-2" });
    }
  });
  it("keeps malformed, transport, and unfamiliar errors uncertain without code-to-status guesses", () => {
    expect(uncertainCommandFailure(new TypeError("connection lost"))).toBe(true);
    expect(uncertainCommandFailure({ error: { code: 42 } })).toBe(true);
    expect(uncertainCommandFailure({ error: { code: "bad_request" } })).toBe(true);
    expect(uncertainCommandFailure({ error: { code: "unexpected_timeout" } })).toBe(true);
    expect(uncertainCommandFailure({ status: 409, code: "unexpected_timeout" })).toBe(false);
    expect(uncertainCommandFailure({ status: 302, code: "bad_request" })).toBe(true);
    expect(uncertainCommandFailure({ status: Number.NaN, code: "bad_request" })).toBe(true);
    expect(
      uncertainCommandFailure({ error: { code: "idempotency_conflict" } }, [
        "idempotency_conflict",
      ]),
    ).toBe(false);
  });
  it("bounds interchange files before reading them", () => {
    expect(validInterchangeFileSize(MAX_INTERCHANGE_FILE_BYTES)).toBe(true);
    expect(validInterchangeFileSize(MAX_INTERCHANGE_FILE_BYTES + 1)).toBe(false);
    expect(validInterchangeFileSize(Number.POSITIVE_INFINITY)).toBe(false);
  });
  const api = (serverBaseUrl: string) =>
    createApiClient({ serverBaseUrl, authentication: { type: "none" } });

  it.each([
    "http://localhost:8787",
    "http://192.168.1.50:8787",
    "http://100.80.20.10:8787",
    "https://video.example.com",
  ])("accepts the configured server URL %s", (serverBaseUrl) => {
    expect(api(serverBaseUrl).url("media")).toBe(`${serverBaseUrl}/api/v2/media`);
  });

  it("keeps native media URLs below the configured deployment prefix", () => {
    const client = api("https://video.example.com/videocutlist/");
    expect(client.mediaUrl("m_fixture/thumbnails?width=240")).toBe(
      "https://video.example.com/videocutlist/media/v2/m_fixture/thumbnails?width=240",
    );
    expect(() => client.mediaUrl("../api/v2/projects")).toThrow();
    expect(() => client.mediaUrl("https://attacker.test/file")).toThrow();
  });

  it("uses the native contract path for bounded media assets", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response("asset")));
    const client = createApiClient(
      { serverBaseUrl: "https://video.example.com", authentication: { type: "none" } },
      fetch,
    );
    await client.assetRequest("m_fixture", "waveform", { startMs: 10, durationMs: 20 });
    expect(String(fetch.mock.calls[0][0])).toBe(
      "https://video.example.com/media/v2/media/m_fixture/waveform?startMs=10&durationMs=20",
    );
  });

  it("streams authenticated media requests through the configured media root", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response("stream")));
    const client = createApiClient(
      {
        serverBaseUrl: "https://video.example.com/videocutlist",
        authentication: { type: "bearer", token: "media-token" },
      },
      fetch,
    );
    const signal = new AbortController().signal;
    const response = await client.mediaRequest("media/m_fixture/preview?centerMs=500", {
      signal,
      headers: { Authorization: "Basic caller", "X-Trace": "preview" },
    });

    expect(response.body).toBeDefined();
    expect(fetch).toHaveBeenCalledWith(
      "https://video.example.com/videocutlist/media/v2/media/m_fixture/preview?centerMs=500",
      expect.objectContaining({ signal, credentials: "omit", redirect: "error" }),
    );
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer media-token");
    expect(new Headers(init.headers).get("x-trace")).toBe("preview");
    expect(() => client.mediaRequest("../api/v2/projects")).toThrow();
    expect(() => client.mediaRequest("https://attacker.test/file")).toThrow();
  });

  it("normalizes trailing slashes and keeps API paths below a prefix", () => {
    const client = api("https://video.example.com/videocutlist///");
    expect(client.url("media/m_a%2Fb?label=two%20words")).toBe(
      "https://video.example.com/videocutlist/api/v2/media/m_a%2Fb?label=two%20words",
    );
  });

  it.each([
    "",
    "localhost:8787",
    "/api",
    "ftp://video.example.com",
    "https://user:pass@video.example.com",
    "https://video.example.com/?query=1",
    "https://video.example.com/#fragment",
  ])("rejects an unsafe server base URL: %s", (serverBaseUrl) => {
    expect(() => api(serverBaseUrl)).toThrow();
  });

  it.each([
    "https://other.example/media",
    "//other.example/media",
    "#fragment",
    "../projects",
    "media/../../projects",
    "media%2f..%2f..%2fadmin",
    "media%5c..%5c..%5cadmin",
    "media%",
  ])("rejects a request path that could escape the API boundary: %s", (path) => {
    expect(() => api("https://video.example.com").url(path)).toThrow();
  });

  it("requests library status through the public route", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response()));
    const client = createApiClient(
      { serverBaseUrl: "https://video.example.com", authentication: { type: "none" } },
      fetch,
    );

    await client.request("media/status");

    expect(fetch).toHaveBeenCalledWith(
      "https://video.example.com/api/v2/media/status",
      expect.objectContaining({ credentials: "omit" }),
    );
  });

  it("keeps the request signal and caller headers for no-auth requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response()));
    const signal = new AbortController().signal;
    const client = createApiClient(
      {
        serverBaseUrl: "https://video.example.com",
        authentication: { type: "none" },
      },
      fetch,
    );

    await client.request("media", {
      signal,
      headers: { Authorization: "Basic ignored", "X-Request-ID": "r-1" },
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://video.example.com/api/v2/media",
      expect.objectContaining({ signal, credentials: "omit" }),
    );
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("x-request-id")).toBe("r-1");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("applies configured bearer and cookie policy to native Effect HTTP", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response("ok")));
    const configuration = {
      serverBaseUrl: "https://video.example.com/videocutlist",
      authentication: { type: "bearer" as const, token: "session-token" },
    };
    const client = api(configuration.serverBaseUrl);
    const layer = createNativeHttpClientLayer(configuration, fetch);
    await runEffect(
      HttpClient.get(client.url("projects"), {
        headers: { authorization: "Basic caller", "x-request-id": "r-native" },
      }).pipe(Effect.provide(layer)),
    );
    await runEffect(
      HttpClient.get(client.mediaUrl("m_fixture/output")).pipe(Effect.provide(layer)),
    );
    expect(String(fetch.mock.calls[0][0])).toBe(
      "https://video.example.com/videocutlist/api/v2/projects",
    );
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("omit");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer session-token");
    expect(new Headers(init.headers).get("x-request-id")).toBe("r-native");
    expect(init.redirect).toBe("error");
    expect(String(fetch.mock.calls[1][0])).toBe(
      "https://video.example.com/videocutlist/media/v2/m_fixture/output",
    );
  });

  it("rejects unsafe native URL origins and roots before fetching credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response("unexpected")));
    const configuration = {
      serverBaseUrl: "https://video.example.com/videocutlist",
      authentication: { type: "bearer" as const, token: "session-token" },
    };
    const layer = createNativeHttpClientLayer(configuration, fetch);
    for (const url of [
      "https://attacker.example/videocutlist/api/v2/projects",
      new URL("https://attacker.example/videocutlist/api/v2/projects"),
      "//attacker.example/videocutlist/api/v2/projects",
      "https://user:secret@video.example.com/videocutlist/api/v2/projects",
      "https://video.example.com/videocutlist/api/v2/projects#fragment",
      "https://video.example.com/videocutlist/api/v2/../../admin",
      "https://video.example.com/videocutlist/api/v2/../media/v2/output",
      "https://video.example.com/videocutlist/api/v2evil/projects",
      "https://video.example.com/videocutlist/media/v2evil/output",
    ]) {
      const failure = await runEffect(HttpClient.get(url).pipe(Effect.provide(layer))).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses cookie credentials and strips caller authorization for native HTTP", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response("ok")));
    const configuration = {
      serverBaseUrl: "https://video.example.com",
      authentication: { type: "cookie" as const },
    };
    await runEffect(
      HttpClient.get("https://video.example.com/api/v2/projects", {
        headers: { authorization: "Basic caller" },
      }).pipe(Effect.provide(createNativeHttpClientLayer(configuration, fetch))),
    );
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("owns the bearer authorization header without losing caller headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response()));
    const client = createApiClient(
      {
        serverBaseUrl: "https://video.example.com",
        authentication: { type: "bearer", token: "editor-token" },
      },
      fetch,
    );

    await client.request("projects/p_demo", {
      headers: new Headers({
        Authorization: "Basic ignored",
        "X-Trace": "yes",
      }),
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://video.example.com/api/v2/projects/p_demo",
      expect.objectContaining({ credentials: "omit" }),
    );
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer editor-token");
    expect(new Headers(init.headers).get("x-trace")).toBe("yes");
  });

  it("uses cookies while centrally removing authorization", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response()));
    const client = createApiClient(
      {
        serverBaseUrl: "https://video.example.com",
        authentication: { type: "cookie" },
      },
      fetch,
    );

    await client.request("media", {
      headers: { Authorization: "Basic ignored" },
    });

    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("ignores an old unauthorized response after authentication changes, but reports the current one", async () => {
    const browser = new EventTarget();
    let required = 0;
    browser.addEventListener(authenticationRequiredEvent, () => required++);
    vi.stubGlobal("window", browser);
    try {
      const configuration = {
        serverBaseUrl: "https://video.example.com",
        authentication: { type: "bearer" as const, token: "previous-token" },
      };
      let respond!: (response: Response) => void;
      const fetch = vi.fn<typeof globalThis.fetch>(
        () => new Promise<Response>((resolve) => (respond = resolve)),
      );
      const client = createApiClient(configuration, fetch);
      const previous = client.request("media");
      configuration.authentication = { type: "bearer", token: "current-token" };
      respond(new Response(null, { status: 401 }));
      await previous;
      expect(required).toBe(0);

      const current = client.request("media");
      respond(new Response(null, { status: 401 }));
      await current;
      expect(required).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["", "\n", "a\tb"])("rejects an invalid bearer token", (token) => {
    expect(() =>
      createApiClient({
        serverBaseUrl: "https://video.example.com",
        authentication: { type: "bearer", token },
      }),
    ).toThrow();
  });
});
