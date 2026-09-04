import { expect, test } from "@playwright/test";

const apiOrigin = "http://127.0.0.1:8787";
const statuses = [
  ["unconfigured", "Media root is not configured.", "Configure the server media root"],
  ["scanning", "Media library is being indexed.", "Wait for indexing to finish"],
  ["ready_empty", "No supported media was found.", "Mount supported media"],
  ["failed", "Media library scan failed.", "Check the server configuration"],
  ["ready_with_media", "Media library is ready.", "Choose a video"],
] as const;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
  });
});

for (const [state, message, action] of statuses) {
  test(`shows one actionable ${state} library message`, async ({ page }) => {
    await page.route(`${apiOrigin}/api/v1/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/media/status") return route.fulfill({ json: { state, message } });
      if (path === "/api/v1/media") return route.fulfill({ json: { items: [] } });
      if (path === "/api/v1/media/tree") return route.fulfill({ json: { folders: [], items: [] } });
      if (path === "/api/v1/destinations") return route.fulfill({ json: { destinations: [] } });
      return route.fulfill({ status: 404 });
    });
    await page.goto("/");
    const setup = page.getByRole("region", { name: "Media library status" });
    await expect(setup).toContainText(message);
    await expect(setup).toContainText(action);
    await expect(setup.getByRole("status")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Choose a video to begin" })).toBeVisible();
  });
}

test("shows one actionable loading message while status is pending", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${apiOrigin}/api/v1/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/media/status") {
      await pending;
      return route.fulfill({
        json: { state: "ready_empty", message: "No supported media was found." },
      });
    }
    if (path === "/api/v1/media") return route.fulfill({ json: { items: [] } });
    if (path === "/api/v1/media/tree") return route.fulfill({ json: { folders: [], items: [] } });
    if (path === "/api/v1/destinations") return route.fulfill({ json: { destinations: [] } });
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

test("browses folders, paginates within the active folder, and returns to root", async ({
  page,
}) => {
  const treeRequests: string[] = [];
  await page.route(`${apiOrigin}/api/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/media/status")
      return route.fulfill({
        json: { state: "ready_with_media", message: "Media library is ready." },
      });
    if (url.pathname === "/api/v1/media/tree") {
      treeRequests.push(url.search);
      const folder = url.searchParams.get("folderId");
      const cursor = url.searchParams.get("cursor");
      if (!folder)
        return route.fulfill({
          json: {
            folders: [{ id: "f_" + "x".repeat(43), label: "Clips" }],
            items: [
              { id: "m_" + "a".repeat(43), name: "root.mp4", durationMs: 1000, container: "mp4" },
            ],
          },
        });
      if (!cursor)
        return route.fulfill({
          json: {
            folders: [],
            items: [
              { id: "m_" + "b".repeat(43), name: "clip-1.mp4", durationMs: 1000, container: "mp4" },
            ],
            nextCursor: "m_" + "c".repeat(43),
          },
        });
      return route.fulfill({
        json: {
          folders: [],
          items: [
            { id: "m_" + "d".repeat(43), name: "clip-2.mp4", durationMs: 1000, container: "mp4" },
          ],
        },
      });
    }
    if (url.pathname === "/api/v1/destinations")
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
  expect(treeRequests).toEqual([
    "",
    "?folderId=f_" + "x".repeat(43),
    "?folderId=f_" + "x".repeat(43) + "&cursor=m_" + "c".repeat(43),
    "",
  ]);
});

test("ignores a delayed folder response after refresh returns to root", async ({ page }) => {
  let releaseFolder!: () => void;
  const folderPending = new Promise<void>((resolve) => (releaseFolder = resolve));
  let folderRequest = false;
  await page.route(`${apiOrigin}/api/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/media/status")
      return route.fulfill({
        json: { state: "ready_with_media", message: "Media library is ready." },
      });
    if (url.pathname === "/api/v1/media/tree") {
      const folder = url.searchParams.get("folderId");
      if (folder && !folderRequest) {
        folderRequest = true;
        await folderPending;
        return route.fulfill({
          json: {
            folders: [],
            items: [
              {
                id: "m_" + "o".repeat(43),
                name: "old-folder.mp4",
                durationMs: 1000,
                container: "mp4",
              },
            ],
          },
        });
      }
      return route.fulfill({
        json: {
          folders: folder ? [] : [{ id: "f_" + "x".repeat(43), label: "Clips" }],
          items: folder
            ? []
            : [{ id: "m_" + "r".repeat(43), name: "root.mp4", durationMs: 1000, container: "mp4" }],
        },
      });
    }
    if (url.pathname === "/api/v1/media/refresh") return route.fulfill({ status: 202 });
    if (url.pathname === "/api/v1/destinations")
      return route.fulfill({ json: { destinations: [] } });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Clips" }).click();
  await page.getByRole("button", { name: "Refresh media" }).click();
  await expect(page.getByRole("button", { name: "Select root.mp4" })).toBeVisible();
  releaseFolder();
  await expect(page.getByRole("button", { name: "Select old-folder.mp4" })).toHaveCount(0);
});

test("loads status once and refreshes it after a rescan", async ({ page }) => {
  let statusRequests = 0;
  await page.route(`${apiOrigin}/api/v1/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/media/status") {
      statusRequests++;
      return route.fulfill({
        json: { state: "ready_empty", message: "No supported media was found." },
      });
    }
    if (path === "/api/v1/media/refresh") return route.fulfill({ status: 202 });
    if (path === "/api/v1/media" || path === "/api/v1/media/tree")
      return route.fulfill({
        json: path.endsWith("tree") ? { folders: [], items: [] } : { items: [] },
      });
    if (path === "/api/v1/destinations") return route.fulfill({ json: { destinations: [] } });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "No supported media" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh media" }).click();
  await expect.poll(() => statusRequests).toBe(2);
});
