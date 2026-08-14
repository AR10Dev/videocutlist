import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api";

describe("client API boundary", () => {
  const api = (serverBaseUrl: string) =>
    createApiClient({ serverBaseUrl, authentication: { type: "none" } });

  it.each([
    "http://localhost:8787",
    "http://192.168.1.50:8787",
    "http://100.80.20.10:8787",
    "https://video.example.com",
  ])("accepts the configured server URL %s", (serverBaseUrl) => {
    expect(api(serverBaseUrl).url("media")).toBe(
      `${serverBaseUrl}/api/v1/media`,
    );
  });

  it("normalizes trailing slashes and keeps API paths below a prefix", () => {
    const client = api("https://video.example.com/videocutlist///");
    expect(client.url("media/m_a%2Fb?label=two%20words")).toBe(
      "https://video.example.com/videocutlist/api/v1/media/m_a%2Fb?label=two%20words",
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
  ])(
    "rejects a request path that could escape the API boundary: %s",
    (path) => {
      expect(() => api("https://video.example.com").url(path)).toThrow();
    },
  );

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
      "https://video.example.com/api/v1/media",
      expect.objectContaining({ signal, credentials: "omit" }),
    );
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("x-request-id")).toBe("r-1");
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
      "https://video.example.com/api/v1/projects/p_demo",
      expect.objectContaining({ credentials: "omit" }),
    );
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer editor-token",
    );
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

  it.each(["", "\n", "a\tb"])("rejects an invalid bearer token", (token) => {
    expect(() =>
      createApiClient({
        serverBaseUrl: "https://video.example.com",
        authentication: { type: "bearer", token },
      }),
    ).toThrow();
  });
});
