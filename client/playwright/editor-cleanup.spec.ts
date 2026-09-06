import { expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:8787";
const media = {
  id: `m_${"a".repeat(43)}`,
  name: "camera.mp4",
  durationMs: 10_000,
  sizeBytes: 1000,
  container: "mp4",
  etag: "v1",
  streams: { tracks: [{ index: 0, type: "video", codec: "h264" }] },
};

function projectResponse(body: Record<string, unknown> = {}) {
  return {
    id: "p_cleanup-project01",
    revision: 1,
    schemaVersion: 2,
    name: "Untitled project",
    updatedAt: "2026-08-20T12:00:00Z",
    items: [],
    ...body,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
  });
  await page.route(`${origin}/api/v1/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/media/status")
      return route.fulfill({
        json: { state: "ready_with_media", message: "Library ready." },
      });
    if (url.pathname === "/api/v1/media/tree")
      return route.fulfill({
        json: { folders: [{ id: "folder-a", label: "Interviews" }], items: [media] },
      });
    if (url.pathname === `/api/v1/media/${media.id}`) return route.fulfill({ json: media });
    if (url.pathname.endsWith("/thumbnails"))
      return route.fulfill({ headers: { "content-type": "image/png" }, body: "not-a-real-png" });
    if (url.pathname.endsWith("/waveform"))
      return route.fulfill({ json: { startMs: 0, durationMs: 10_000, peaks: [0.2, 0.8] } });
    if (url.pathname === "/api/v1/destinations")
      return route.fulfill({
        json: { destinations: [{ id: "download", label: "Browser download", kind: "download" }] },
      });
    if (url.pathname.endsWith("/exports/preflight"))
      return route.fulfill({ json: { allowed: true, selection: [], findings: [] } });
    if (url.pathname === "/api/v1/batches") return route.fulfill({ json: { items: [] } });
    if (url.pathname.startsWith("/api/v1/projects/") && request.method() === "PUT")
      return route.fulfill({
        json: projectResponse(request.postDataJSON() as Record<string, unknown>),
      });
    if (url.pathname.startsWith("/api/v1/projects/"))
      return route.fulfill({ json: projectResponse() });
    if (url.pathname === "/api/v1/media/refresh")
      return route.fulfill({
        status: 200,
        json: { id: "scan-succeeded", state: "succeeded", progress: 1, indexed: 1 },
      });
    if (url.pathname.startsWith("/api/v1/media/import/"))
      return route.fulfill({
        json: { id: "scan-succeeded", state: "succeeded", progress: 1, indexed: 1 },
      });
    return route.fulfill({ status: 404 });
  });
});

test("workspace uses project controls on the left and keeps tasks focused", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".workspace-action-row")).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Project status" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save project from project header" }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Cuts", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Auto-detect", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Export", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Project", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Export queue" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Export queue" })).toBeVisible();
});

test("successful scans stay quiet while media remains browsable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Refresh media" }).click();
  await expect(page.getByText(/Scan succeeded/)).toHaveCount(0);
  await expect(page.getByText("Indexing media…")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select camera.mp4" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Interviews" })).toBeVisible();
});

test("settings keeps the media trigger reachable after a persisted panel preference reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem(
      "videocutlist.workspace-panels.v1",
      JSON.stringify({
        mediaWidth: 240,
        segmentsWidth: 300,
        mediaCollapsed: false,
        segmentsCollapsed: false,
      }),
    ),
  );
  await page.getByRole("button", { name: "Settings" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = JSON.parse(
          localStorage.getItem("videocutlist.workspace-panels.v1") ?? "null",
        );
        return stored?.mediaCollapsed;
      }),
    )
    .toBe(false);
  await page.reload();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
});

test("current media metadata failures remain visible", async ({ page }) => {
  await page.route(`${origin}/api/v1/media/${media.id}`, (route) => route.fulfill({ status: 503 }));
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  // Metadata queries retry transient failures before exposing the final error.
  await expect(page.getByText("Metadata request failed (503).", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("Metadata request failed (503).", { exact: true })).toHaveCount(1);
});

test("pressing Start again creates a second segment without overwriting the first", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  const playhead = page.getByLabel("Timeline playhead");
  await playhead.fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await playhead.fill("300");
  await page.getByRole("button", { name: "Set out" }).click();
  await playhead.fill("500");
  await page.getByRole("button", { name: "Set in" }).click();
  await expect(page.getByLabel("In point")).toHaveValue("00:00.500");
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);
  await playhead.fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(2);
  await expect(
    page.getByRole("list", { name: "Selected cuts" }).getByRole("listitem").nth(0),
  ).toContainText("00:00.100");
  await expect(
    page.getByRole("list", { name: "Selected cuts" }).getByRole("listitem").nth(1),
  ).toContainText("00:00.500");
});
