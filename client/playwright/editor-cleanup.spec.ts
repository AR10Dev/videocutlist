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
  await page.route(`${origin}/api/v2/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v2/media/status")
      return route.fulfill({
        json: { state: "ready_with_media", message: "Library ready." },
      });
    if (url.pathname === "/api/v2/media/tree")
      return route.fulfill({
        json: {
          folders: [{ id: "f_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", label: "Interviews" }],
          items: [media],
          nextCursor: null,
        },
      });
    if (url.pathname === `/api/v2/media/${media.id}`) return route.fulfill({ json: media });
    if (url.pathname === "/api/v2/destinations")
      return route.fulfill({
        json: { destinations: [{ id: "download", label: "Browser download", kind: "download" }] },
      });
    if (url.pathname.endsWith("/exports/preflight"))
      return route.fulfill({ json: { allowed: true, selection: [], findings: [] } });
    if (url.pathname === "/api/v2/batches")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (url.pathname.startsWith("/api/v2/projects/") && request.method() === "PUT")
      return route.fulfill({
        json: projectResponse(request.postDataJSON() as Record<string, unknown>),
      });
    if (url.pathname.startsWith("/api/v2/projects/"))
      return route.fulfill({ json: projectResponse() });
    if (url.pathname === "/api/v2/media/refresh") {
      expect(request.headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      return route.fulfill({
        status: 202,
        json: { id: "j_scan_succeeded", state: "succeeded", progress: 1, indexed: 1 },
      });
    }
    return route.fulfill({ status: 404 });
  });
});

test.beforeEach(async ({ page }) => {
  await page.route(`${origin}/media/v2/media/${media.id}/thumbnails**`, (route) =>
    route.fulfill({ status: 503 }),
  );
  await page.route(`${origin}/media/v2/media/${media.id}/waveform**`, (route) =>
    route.fulfill({ json: { startMs: 0, durationMs: 10_000, peaks: [0.2, 0.8] } }),
  );
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

test("metadata retries are bounded, report HTTP status, and permit an explicit retry", async ({
  page,
}) => {
  let attempts = 0;
  await page.route(`${origin}/api/v2/media/${media.id}`, (route) => {
    attempts++;
    return route.fulfill({ status: 503 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  const timeline = page.getByRole("region", { name: "Timeline", exact: true });
  const error = timeline.getByRole("alert");
  await expect(error).toBeVisible({ timeout: 10_000 });
  expect(attempts).toBe(4);
  await expect(error).toContainText("503");
  await expect(page.getByLabel("Timeline playhead")).toBeVisible();
  await page.route(`${origin}/api/v2/media/${media.id}`, (route) => route.fulfill({ json: media }));
  await page.getByRole("button", { name: "Retry metadata" }).click();
  await expect(error).toHaveCount(0);
});

test("metadata recovers from a transient failure without an explicit retry", async ({ page }) => {
  let attempts = 0;
  await page.route(`${origin}/api/v2/media/${media.id}`, (route) => {
    attempts++;
    return attempts === 1
      ? route.fulfill({ status: 503 })
      : route.fulfill({ json: { ...media, name: "recovered-camera.mp4" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  const timeline = page.getByRole("region", { name: "Timeline", exact: true });
  await expect(timeline.getByText("recovered-camera.mp4", { exact: true })).toBeVisible();
  await expect(timeline.getByRole("alert")).toHaveCount(0);
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
  await expect(page.locator("#timeline-description")).toContainText("In marker 00:00.500");
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
