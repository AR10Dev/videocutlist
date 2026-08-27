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
    if (route.request().method() === "PUT") return route.fulfill({ json: { revision: 1 } });
    return route.fulfill({ status: 404 });
  });

  await page.goto("/");
  await expect(page.getByText("they do not upload or add a video")).toBeVisible();
  await expect(page.getByLabel("Import cut list")).toHaveCount(0);
  await expect(page.getByLabel("Import CSV or chapters")).toHaveCount(0);

  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await expect(page.getByLabel("Import cut list")).toBeVisible();
  await expect(page.getByLabel("Import CSV or chapters")).toHaveCount(0);

  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByLabel("Import CSV or chapters")).toBeVisible();
});
