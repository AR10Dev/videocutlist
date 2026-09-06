import { expect, test, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:8787";
const media = {
  id: `m_${"a".repeat(43)}`,
  name: "camera.mp4",
  durationMs: 10_000,
  sizeBytes: 1000,
  container: "mp4",
  streams: { tracks: [{ index: 0, type: "video", codec: "h264" }] },
  etag: "v1",
};
const secondMedia = {
  ...media,
  id: `m_${"b".repeat(43)}`,
  name: "second.mp4",
  etag: "v2",
};

async function addSegment(page: Page) {
  const playhead = page.getByLabel("Timeline playhead");
  await playhead.fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await playhead.fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);
  await expect(page.locator('button[aria-label="Select cut 1"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

async function openMediaChooser(page: Page) {
  const change = page.getByRole("button", { name: "Change video" });
  if (await change.isVisible()) await change.click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
    Object.defineProperty(window, "MediaSource", { value: undefined });
  });
  await page.route(`${origin}/api/v1/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/media/tree"))
      return route.fulfill({ json: { folders: [], items: [media, secondMedia] } });
    if (path.endsWith("/media/status"))
      return route.fulfill({ json: { state: "ready_with_media", message: "Library ready." } });
    if (path.endsWith(`/media/${media.id}`)) return route.fulfill({ json: media });
    if (path.endsWith(`/media/${secondMedia.id}`)) return route.fulfill({ json: secondMedia });
    if (path.endsWith("/waveform"))
      return route.fulfill({ json: { startMs: 0, durationMs: 10_000, peaks: [0.2, 0.8] } });
    if (path.endsWith("/thumbnails")) return route.fulfill({ status: 503 });
    if (path.endsWith("/destinations"))
      return route.fulfill({
        json: {
          destinations: [
            { id: "download", label: "Browser download", kind: "download", retention: "24h" },
          ],
        },
      });
    if (path.endsWith("/settings"))
      return route.fulfill({
        json: {
          revision: 1,
          schemaVersion: 1,
          roots: { media: { state: "ready" } },
          settings: { exportLimit: 1, previewGlobalLimit: 2 },
        },
      });
    if (path.endsWith("/batches")) return route.fulfill({ json: { items: [] } });
    if (path.endsWith("/exports/preflight"))
      return route.fulfill({ json: { allowed: true, selection: [], findings: [] } });
    if (/\/projects\/[^/]+\/exports$/.test(path))
      return route.fulfill({
        status: 202,
        json: {
          batchId: "b_membership01",
          jobs: [{ id: "j_membership01", type: "export", state: "queued", progress: 0 }],
        },
      });
    if (/\/projects\/[^/]+$/.test(path) && request.method() === "PUT") {
      const body = request.postDataJSON();
      return route.fulfill({ json: { ...body, id: path.split("/").pop(), revision: 1 } });
    }
    return route.fulfill({ status: 404 });
  });
});

test("browsing stays out of the project until add, then activates without duplication", async ({
  page,
}) => {
  let exportBody: Record<string, unknown> | undefined;
  page.on("request", (request) => {
    if (request.url().endsWith("/exports"))
      exportBody = request.postDataJSON() as Record<string, unknown>;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await expect(page.getByRole("button", { name: "Add to project" })).toBeVisible();

  await expect(page.getByRole("list", { name: "Project media items" })).toHaveCount(0);

  await page.getByRole("button", { name: "Add to project" }).click();
  const projectItems = page.getByRole("list", { name: "Project media items" });
  await expect(projectItems.getByRole("button", { name: /^camera\.mp4/ })).toBeVisible();
  await addSegment(page);

  await openMediaChooser(page);
  await page.getByRole("button", { name: "Select second.mp4" }).click();
  await expect(page.getByRole("button", { name: "Add to project" })).toBeVisible();
  await expect(projectItems).toHaveCount(1);
  await expect(projectItems.getByRole("button", { name: /^second\.mp4/ })).toHaveCount(0);
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(page.getByLabel("Export summary")).toContainText("0 · 00:00.000 requested");
  await expect(page.getByRole("button", { name: "Create clips" })).toBeDisabled();

  await page.getByRole("button", { name: "Add to project" }).click();
  await expect(projectItems.getByRole("button", { name: /^camera\.mp4/ })).toBeVisible();
  await expect(projectItems.getByRole("button", { name: /^second\.mp4/ })).toBeVisible();

  await openMediaChooser(page);
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await expect(page.getByRole("button", { name: "Add to project" })).toHaveCount(0);
  await expect(projectItems.getByRole("button", { name: /^camera\.mp4/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(projectItems.getByRole("button", { name: /^camera\.mp4/ })).toHaveCount(1);

  await page.getByRole("tab", { name: "Export", exact: true }).click();
  const exportPanel = page.getByRole("region", { name: "Export" });
  const activeScope = exportPanel.getByRole("radio", { name: "Active media item" });
  const selectedScope = exportPanel.getByRole("radio", { name: "Selected project items" });
  await expect(activeScope).toBeChecked();
  await expect(page.getByLabel("Export summary")).toContainText("camera.mp4");
  await expect(page.getByLabel("Export summary")).toContainText("1 · 00:00.600 requested");
  await expect(exportPanel.getByRole("checkbox")).toHaveCount(0);

  await selectedScope.check();
  await expect(page.getByLabel("Export summary")).toContainText("2 project items");
  await expect(exportPanel.getByRole("checkbox", { name: "camera.mp4" })).toBeChecked();
  await expect(exportPanel.getByRole("checkbox", { name: "second.mp4" })).toBeChecked();

  await activeScope.check();
  await expect(page.getByLabel("Export summary")).toContainText("camera.mp4");
  await expect(page.getByLabel("Export summary")).toContainText("1 · 00:00.600 requested");
  await page.getByRole("button", { name: "Create clips" }).click();
  await expect(page.getByText("Export queued.")).toBeVisible();
  expect(exportBody?.itemIds).toEqual([expect.any(String)]);
});
