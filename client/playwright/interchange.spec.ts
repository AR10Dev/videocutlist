import { expect, test } from "@playwright/test";

const media = {
  id: "m_0123456789012345678901234567890123456789012",
  name: "camera.mp4",
  durationMs: 10_000,
  sizeBytes: 1000,
  container: "mp4",
  streams: {},
  etag: "v1",
};

test("project interchange controls wait for media selection", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a video to begin" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Timeline editing" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Detection" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Export" })).toBeDisabled();
  await expect(
    page.getByText("Select a video from the Media library to unlock the editing workspace."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Export CSV" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Export chapters" })).not.toBeVisible();
  await expect(page.getByLabel("Import CSV or chapters")).not.toBeVisible();
});

test("gates interchange exports until the project is persisted", async ({ page }) => {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
  });
  await page.route("http://127.0.0.1:8787/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/media") return route.fulfill({ json: { items: [media] } });
    if (url.pathname === `/api/v1/media/${media.id}`) return route.fulfill({ json: media });
    if (url.pathname === "/api/v1/media/status")
      return route.fulfill({ json: { state: "ready_empty", message: "Ready" } });
    if (route.request().method() === "PUT")
      return route.fulfill({ json: { id: "p_saved", revision: 1 } });
    return route.fulfill({ status: 404 });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Export chapters" })).toBeDisabled();
  await expect(
    page.getByText("Save or load the selected video's project before exporting CSV or chapters."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Export chapters" })).toBeEnabled();
});

test("separates media selection from cut-list imports", async ({ page }) => {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
  });
  await page.route("http://127.0.0.1:8787/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/media") return route.fulfill({ json: { items: [media] } });
    if (url.pathname === `/api/v1/media/${media.id}`) return route.fulfill({ json: media });
    if (url.pathname === "/api/v1/media/status")
      return route.fulfill({ json: { state: "ready_empty", message: "Ready" } });
    if (route.request().method() === "PUT") return route.fulfill({ json: { revision: 1 } });
    return route.fulfill({ status: 404 });
  });

  await page.goto("/");
  await expect(page.getByLabel("Import cut list")).toHaveCount(0);
  await expect(page.getByLabel("Import CSV or chapters")).toHaveCount(0);

  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Export" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Auto detection" })).toBeVisible();
  await expect(page.getByLabel("Import cut list")).toBeVisible();
  await expect(page.getByLabel("Import CSV or chapters")).toHaveCount(0);

  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByLabel("Import CSV or chapters")).toBeVisible();
});
