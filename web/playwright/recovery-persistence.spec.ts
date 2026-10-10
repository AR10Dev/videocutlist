import { expect, test, type Page } from "@playwright/test";
import { mediaFixture } from "./fixtures";

const origin = "http://127.0.0.1:8787";
const recoveryKey = "videocutlist.project-recovery.v1";

async function mockWorkspaceApi(page: Page, writes: unknown[]) {
  await page.route(`${origin}/api/v2/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v2/media/tree")
      return route.fulfill({ json: { folders: [], items: [mediaFixture] } });
    if (url.pathname === `/api/v2/media/${mediaFixture.id}`)
      return route.fulfill({ json: mediaFixture });
    if (url.pathname === "/api/v2/media/status")
      return route.fulfill({ json: { state: "ready_with_media", message: "Ready" } });
    if (url.pathname === "/api/v2/settings") return route.fulfill({ json: {} });
    if (url.pathname === "/api/v2/destinations")
      return route.fulfill({ json: { destinations: [] } });
    if (url.pathname === "/api/v2/batches") return route.fulfill({ json: { items: [] } });
    if (request.method() === "PUT" && /^\/api\/v2\/projects\/[^/]+$/.test(url.pathname)) {
      const body = request.postDataJSON();
      writes.push(body);
      return route.fulfill({
        json: {
          ...body,
          id: url.pathname.split("/").at(-1),
          revision: writes.length,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
    }
    return route.fulfill({ status: 404 });
  });
}

async function editProjectWithMedia(page: Page) {
  await page.getByRole("button", { name: /camera\.mp4/ }).click();
  await page.getByRole("button", { name: "Add to project" }).click();
  await page.getByLabel("Timeline playhead").fill("500");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("1000");
  await page.getByRole("button", { name: "Set out" }).click();
}

test("shows a safe recovery read warning and clears it after a successful recovery write", async ({
  page,
}) => {
  const writes: unknown[] = [];
  await page.addInitScript((key) => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
    const getItem = Storage.prototype.getItem;
    let failed = false;
    Storage.prototype.getItem = function (storedKey) {
      if (storedKey === key && !failed) {
        failed = true;
        throw new DOMException("private browser storage detail", "SecurityError");
      }
      return getItem.call(this, storedKey);
    };
  }, recoveryKey);
  await mockWorkspaceApi(page, writes);
  await page.goto("/");

  const warning = page.getByRole("alert").filter({ hasText: "Local recovery could not be read." });
  await expect(warning).toContainText("Unsaved edits may not survive closing this tab.");
  await expect(warning).not.toContainText("private browser storage detail");

  await editProjectWithMedia(page);
  await expect(warning).toHaveCount(0);
  await page.getByRole("button", { name: "Save project from project header", exact: true }).click();
  await expect(page.getByRole("status", { name: "Project status" })).toHaveText("Saved");
  expect(writes).toHaveLength(1);
});

test("shows a safe recovery write warning while server project saves continue", async ({
  page,
}) => {
  const writes: unknown[] = [];
  await page.addInitScript((key) => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (storedKey, value) {
      if (storedKey === key)
        throw new DOMException("private browser storage detail", "QuotaExceededError");
      return setItem.call(this, storedKey, value);
    };
  }, recoveryKey);
  await mockWorkspaceApi(page, writes);
  await page.goto("/");
  await editProjectWithMedia(page);

  const warning = page.getByRole("alert").filter({ hasText: "Local recovery could not be saved." });
  await expect(warning).toContainText("Unsaved edits may not survive closing this tab.");
  await expect(warning).not.toContainText("private browser storage detail");
  await page.getByRole("button", { name: "Save project from project header", exact: true }).click();
  await expect(page.getByRole("status", { name: "Project status" })).toHaveText("Saved");
  expect(writes).toHaveLength(1);
});
