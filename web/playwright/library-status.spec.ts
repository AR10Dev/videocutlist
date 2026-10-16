import { expect, test } from "@playwright/test";

const apiOrigin = "http://127.0.0.1:8787";
const emptyLibrary = {
  state: "ready_empty",
  message: "No supported media was found.",
  action: "Mount supported media",
} as const;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
  });
});

test("shows the empty-library status region", async ({ page }) => {
  await page.route(`${apiOrigin}/api/v2/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v2/media/status")
      return route.fulfill({
        json: { state: emptyLibrary.state, message: emptyLibrary.message },
      });
    if (path === "/api/v2/media") return route.fulfill({ json: { items: [] } });
    if (path === "/api/v2/media/tree") return route.fulfill({ json: { folders: [], items: [] } });
    if (path === "/api/v2/destinations") return route.fulfill({ json: { destinations: [] } });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  const setup = page.getByRole("region", { name: "Media library status" });
  await expect(setup).toContainText(emptyLibrary.message);
  await expect(setup).toContainText(emptyLibrary.action);
  await expect(setup.getByRole("status")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Choose a video to begin" })).toBeVisible();
});

test("shows one actionable loading message while status is pending", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${apiOrigin}/api/v2/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v2/media/status") {
      await pending;
      return route.fulfill({
        json: { state: "ready_empty", message: "No supported media was found." },
      });
    }
    if (path === "/api/v2/media") return route.fulfill({ json: { items: [] } });
    if (path === "/api/v2/media/tree") return route.fulfill({ json: { folders: [], items: [] } });
    if (path === "/api/v2/destinations") return route.fulfill({ json: { destinations: [] } });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  const setup = page.getByRole("region", { name: "Media library status" });
  await expect(setup.getByRole("status")).toHaveText(
    "Checking the server media library… Refresh to check again.",
  );
  await expect(setup.getByRole("status")).toHaveCount(1);
  release();
});

test("requests library thumbnails only when their rows become visible", async ({ page }) => {
  const items = Array.from({ length: 50 }, (_, index) => ({
    id: `m_${String(index).padStart(43, "0")}`,
    name: `clip-${index}.mp4`,
    durationMs: 1000,
    container: "mp4",
    sizeBytes: 1000,
    streams: {},
    etag: "fixture",
  }));
  const requested = new Set<string>();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.route(`${apiOrigin}/api/v2/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v2/media/status")
      return route.fulfill({
        json: { state: "ready_with_media", message: "Media library is ready." },
      });
    if (path === "/api/v2/media/tree") return route.fulfill({ json: { folders: [], items } });
    if (path === "/api/v2/destinations") return route.fulfill({ json: { destinations: [] } });
    return route.fulfill({ status: 404 });
  });
  await page.route(`${apiOrigin}/media/v2/media/*/thumbnails*`, async (route) => {
    requested.add(new URL(route.request().url()).pathname.split("/")[4]);
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Select clip-0.mp4", exact: true })).toBeVisible();
  await expect.poll(() => requested.has(items[0].id)).toBe(true);
  await page.waitForLoadState("networkidle");
  expect(requested.has(items[49].id)).toBe(false);
  await page
    .getByRole("button", { name: "Select clip-49.mp4", exact: true })
    .scrollIntoViewIfNeeded();
  await expect.poll(() => requested.has(items[49].id)).toBe(true);
});

test("browses folders, paginates within the active folder, and returns to root", async ({
  page,
}) => {
  const treeRequests: string[] = [];
  await page.route(`${apiOrigin}/api/v2/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v2/media/status")
      return route.fulfill({
        json: { state: "ready_with_media", message: "Media library is ready." },
      });
    if (url.pathname === "/api/v2/media/tree") {
      treeRequests.push(url.search);
      const folder = url.searchParams.get("folderId");
      const cursor = url.searchParams.get("cursor");
      if (!folder)
        return route.fulfill({
          json: {
            folders: [{ id: "f_" + "x".repeat(43), label: "Clips" }],
            items: [
              {
                id: "m_" + "a".repeat(43),
                name: "root.mp4",
                durationMs: 1000,
                container: "mp4",
                sizeBytes: 1000,
                streams: {},
                etag: "fixture",
              },
            ],
          },
        });
      if (!cursor)
        return route.fulfill({
          json: {
            folders: [],
            items: [
              {
                id: "m_" + "b".repeat(43),
                name: "clip-1.mp4",
                durationMs: 1000,
                container: "mp4",
                sizeBytes: 1000,
                streams: {},
                etag: "fixture",
              },
            ],
            nextCursor: "m_" + "c".repeat(43),
          },
        });
      return route.fulfill({
        json: {
          folders: [],
          items: [
            {
              id: "m_" + "d".repeat(43),
              name: "clip-2.mp4",
              durationMs: 1000,
              container: "mp4",
              sizeBytes: 1000,
              streams: {},
              etag: "fixture",
            },
          ],
        },
      });
    }
    if (url.pathname === "/api/v2/destinations")
      return route.fulfill({ json: { destinations: [] } });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Clips" }).click();
  await expect(page.getByRole("button", { name: "Select clip-1.mp4" })).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("button", { name: "Select clip-2.mp4" })).toBeVisible();
  await page.getByRole("button", { name: /All media/ }).click();
  await expect(page.getByRole("button", { name: "Select root.mp4" })).toBeVisible();
  expect(treeRequests.slice(0, 3)).toEqual([
    "",
    "?folderId=f_" + "x".repeat(43),
    "?folderId=f_" + "x".repeat(43) + "&cursor=m_" + "c".repeat(43),
  ]);
  // An idle root atom may be collected before returning; only root may refetch.
  expect(treeRequests.slice(3).every((query) => query === "")).toBe(true);
  expect(treeRequests.length).toBeLessThanOrEqual(4);
});

test("loads status once and refreshes it after a rescan", async ({ page }) => {
  let statusRequests = 0;
  await page.route(`${apiOrigin}/api/v2/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v2/media/status") {
      statusRequests++;
      return route.fulfill({
        json: { state: "ready_empty", message: "No supported media was found." },
      });
    }
    if (path === "/api/v2/media/refresh")
      return route.fulfill({
        status: 202,
        json: { id: "j_abcdefghijkl", state: "queued", progress: 0, indexed: 0 },
      });
    if (path === "/api/v2/jobs/j_abcdefghijkl/events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: `event: snapshot\nid: cursor-1\ndata: ${JSON.stringify({
          id: "j_abcdefghijkl",
          type: "library_scan",
          state: "running",
          revision: 1,
          progress: 0.5,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:01Z",
        })}\n\n`,
      });
    if (path === "/api/v2/media" || path === "/api/v2/media/tree")
      return route.fulfill({
        json: path.endsWith("tree") ? { folders: [], items: [] } : { items: [] },
      });
    if (path === "/api/v2/destinations") return route.fulfill({ json: { destinations: [] } });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "No supported media" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh media" }).click();
  await expect.poll(() => statusRequests).toBe(2);
});

test("keeps one media retry pending and tracks its scan", async ({ page }) => {
  let submissions = 0;
  const keys: string[] = [];
  let releaseRetry!: () => void;
  const retryPending = new Promise<void>((resolve) => (releaseRetry = resolve));
  await page.route(`${apiOrigin}/api/v2/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v2/media/refresh") {
      submissions++;
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      if (submissions === 1) {
        return route.fulfill({
          status: 202,
          json: { id: "j_abcdefghijkl", state: "failed", progress: 0, indexed: 0 },
        });
      }
      await retryPending;
      return route.fulfill({
        status: 202,
        json: { id: "j_mnopqrstuvwx", state: "running", progress: 0.5, indexed: 7 },
      });
    }
    if (path === "/api/v2/jobs/j_abcdefghijkl/events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: `event: snapshot\nid: cursor-1\ndata: ${JSON.stringify({
          id: "j_abcdefghijkl",
          type: "library_scan",
          state: "failed",
          revision: 1,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:01Z",
        })}\n\n`,
      });
    if (path === "/api/v2/jobs/j_mnopqrstuvwx/events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: `event: snapshot\nid: cursor-1\ndata: ${JSON.stringify({
          id: "j_mnopqrstuvwx",
          type: "library_scan",
          state: "running",
          revision: 1,
          progress: 0.5,
          indexed: 7,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:01Z",
        })}\n\n`,
      });
    if (path === "/api/v2/media/status") {
      return route.fulfill({ json: { state: "ready_empty", message: "No supported media." } });
    }
    if (path === "/api/v2/media/tree") return route.fulfill({ json: { folders: [], items: [] } });
    if (path === "/api/v2/destinations") return route.fulfill({ json: { destinations: [] } });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Refresh media" }).click();
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  try {
    await retry.click();
    await expect(retry).toBeDisabled();
    await expect(page.getByRole("button", { name: "Refresh media" })).toBeDisabled();
    expect(submissions).toBe(2);
  } finally {
    releaseRetry();
  }
  await expect(page.getByRole("status", { name: "Library scan" })).toContainText("7 indexed");
  await expect(retry).toHaveCount(0);
  expect(submissions).toBe(2);
  expect(keys).toHaveLength(2);
  expect(keys.every((key) => /^[A-Za-z0-9_-]{1,128}$/.test(key))).toBe(true);
  expect(keys[0]).not.toBe(keys[1]);
});
