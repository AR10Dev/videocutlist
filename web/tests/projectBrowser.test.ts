import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createApiClient } from "../src/api";
import { createServerState } from "../src/app/server";
import { createProjectBrowser } from "../src/features/projects/browser";

const item = (id: string) => ({ id, name: id, revision: 1, updatedAt: "2026-01-01T00:00:00Z" });
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const registries: AtomRegistry.AtomRegistry[] = [];
afterEach(() => {
  registries.forEach((registry) => registry.dispose());
  registries.length = 0;
  vi.unstubAllGlobals();
});
function setup() {
  const requests: {
    url: URL;
    resolve: (response: Response) => void;
    signal?: AbortSignal | null;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve) =>
        requests.push({ url: new URL(String(input)), resolve, signal: init?.signal }),
      ),
  );
  const configuration = {
    serverBaseUrl: "https://example.test",
    authentication: { type: "none" as const },
  };
  const registry = AtomRegistry.make();
  registries.push(registry);
  const server = createServerState(createApiClient(configuration), registry, configuration);
  const browser = createProjectBrowser(server);
  const done = () =>
    Effect.runPromise(AtomRegistry.getResult(registry, browser.result, { suspendOnWaiting: true }));
  return { requests, registry, browser, done };
}

describe("project browser session", () => {
  it("loads 50, appends a cursor only once, and refreshes accumulated pages", async () => {
    const { requests, registry, browser, done } = setup();
    browser.open();
    browser.open();
    await flush();
    expect(registry.get(browser.result).waiting).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].url.searchParams.get("limit")).toBe("50");
    expect(requests[0].url.searchParams.has("cursor")).toBe(false);
    requests[0].resolve(Response.json({ items: [item("first")], nextCursor: "cursor/page+2" }));
    await done();
    const unsubscribe = registry.subscribe(browser.page, () => {});
    unsubscribe();
    await flush();
    expect(registry.get(browser.page).items).toEqual([item("first")]);
    browser.loadMore();
    browser.loadMore();
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1].url.searchParams.get("cursor")).toBe("cursor/page+2");
    requests[1].resolve(Response.json({ items: [item("second")], nextCursor: null }));
    await done();
    expect(registry.get(browser.page).items.map((item) => item.id)).toEqual(["first", "second"]);
    browser.loadMore();
    await flush();
    expect(requests).toHaveLength(2);
    browser.refresh();
    await flush();
    expect(registry.get(browser.page)).toEqual({ items: [], nextCursor: null });
    requests[2].resolve(Response.json({ items: [item("refreshed")], nextCursor: null }));
    await done();
    expect(registry.get(browser.page).items).toEqual([item("refreshed")]);
  });

  it("keeps displayed pages and cursor after failure and retries the same page", async () => {
    const { requests, registry, browser, done } = setup();
    browser.open();
    await flush();
    requests[0].resolve(Response.json({ items: [item("first")], nextCursor: "next" }));
    await done();
    browser.loadMore();
    await flush();
    requests[1].resolve(
      Response.json(
        { error: { code: "unavailable", message: "private details", requestId: "test" } },
        { status: 500 },
      ),
    );
    await expect(done()).rejects.toThrow(
      "Saved projects could not be loaded. Try Refresh projects.",
    );
    expect(AsyncResult.isFailure(registry.get(browser.result))).toBe(true);
    expect(registry.get(browser.page)).toEqual({ items: [item("first")], nextCursor: "next" });
    browser.loadMore();
    await flush();
    expect(requests[2].url.searchParams.get("cursor")).toBe("next");
    requests[2].resolve(Response.json({ items: [item("second")], nextCursor: null }));
    await done();
    expect(registry.get(browser.page).items).toEqual([item("first"), item("second")]);
  });

  it("rejects late pages after close/reopen and superseding refresh, and releases command mounts", async () => {
    const { requests, registry, browser, done } = setup();
    browser.open();
    await flush();
    browser.close();
    await flush();
    expect(registry.getNodes().get(browser.result)?.listeners.size ?? 0).toBe(0);
    expect(registry.getNodes().get(browser.page)?.listeners.size ?? 0).toBe(0);
    expect(registry.get(browser.result).waiting).toBe(false);
    browser.open();
    await flush();
    requests[0].resolve(Response.json({ items: [item("closed")], nextCursor: "stale" }));
    await flush();
    expect(registry.get(browser.page).items).toEqual([]);
    browser.refresh();
    await flush();
    requests[1].resolve(Response.json({ items: [item("superseded")], nextCursor: "stale" }));
    requests[2].resolve(Response.json({ items: [], nextCursor: null }));
    await done();
    expect(registry.get(browser.page)).toEqual({ items: [], nextCursor: null });
    expect(AsyncResult.isSuccess(registry.get(browser.result))).toBe(true);
    browser.close();
    browser.refresh();
    browser.loadMore();
    await flush();
    expect(requests).toHaveLength(3);
    expect(AsyncResult.isInitial(registry.get(browser.result))).toBe(true);
  });
});
