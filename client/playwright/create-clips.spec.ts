import { expect, test, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:8787";
const media = {
  id: "m_0123456789012345678901234567890123456789012",
  name: "camera.mp4",
  durationMs: 10_000,
  sizeBytes: 1000,
  container: "mp4",
  streams: { tracks: [{ index: 0, type: "video", codec: "h264" }] },
  etag: "v1",
};
const secondMedia = {
  ...media,
  id: "m_second-012345678901234567890123456789012345",
  name: "second.mp4",
};

async function addSegment(page: Page, start = 100, end = 700) {
  const playhead = page.getByLabel("Timeline playhead");
  await playhead.fill(String(start));
  await page.getByRole("button", { name: "Set in" }).click();
  await playhead.fill(String(end));
  await page.getByRole("button", { name: "Set out" }).click();
  await page.getByRole("button", { name: /Add cut \(Add segment\)/ }).click();
}

async function openExport(page: Page) {
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create clips" })).toBeVisible();
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
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/v1/media/status")
      return route.fulfill({ json: { state: "ready_with_media", message: "Library ready." } });
    if (path === "/api/v1/media/tree")
      return route.fulfill({ json: { folders: [], items: [media, secondMedia] } });
    if (path === `/api/v1/media/${media.id}`) return route.fulfill({ json: media });
    if (path === `/api/v1/media/${secondMedia.id}`) return route.fulfill({ json: secondMedia });
    if (path.endsWith("/thumbnails")) return route.fulfill({ status: 503 });
    if (path.endsWith("/waveform"))
      return route.fulfill({ json: { startMs: 0, durationMs: 10_000, peaks: [0.2, 0.8] } });
    if (path === "/api/v1/destinations")
      return route.fulfill({
        json: {
          destinations: [
            { id: "download", label: "Browser download", kind: "download", retention: "24h" },
            { id: "archive", label: "Review archive", kind: "archive", retention: "durable" },
          ],
        },
      });
    if (path === "/api/v1/settings")
      return route.fulfill({
        json: {
          revision: 1,
          schemaVersion: 1,
          roots: { media: { state: "ready" } },
          settings: { exportLimit: 1, previewGlobalLimit: 2 },
        },
      });
    if (path.startsWith("/api/v1/batches")) return route.fulfill({ json: { items: [] } });
    if (path.endsWith("/exports/preflight"))
      return route.fulfill({ json: { allowed: true, selection: [], findings: [] } });
    if (/^\/api\/v1\/projects\/[^/]+\/exports$/.test(path))
      return route.fulfill({
        status: 202,
        json: {
          batchId: "b_create-clips01",
          jobs: [{ id: "j_create-clips01", type: "export", state: "queued", progress: 0 }],
        },
      });
    if (/^\/api\/v1\/projects\/[^/]+$/.test(path)) {
      if (request.method() === "PUT") {
        const body = request.postDataJSON();
        return route.fulfill({ json: { ...body, id: path.split("/").pop(), revision: 1 } });
      }
      return route.fulfill({ status: 404 });
    }
    return route.fulfill({ status: 404 });
  });
});

test("Create clips saves a dirty revision before fresh preflight and batch submission", async ({
  page,
}) => {
  const calls: string[] = [];
  let savedBody: Record<string, unknown> | undefined;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "PUT" && /^\/api\/v1\/projects\/[^/]+$/.test(path)) {
      calls.push("save");
      savedBody = request.postDataJSON() as Record<string, unknown>;
    } else if (path.endsWith("/exports/preflight")) calls.push("preflight");
    else if (path.endsWith("/exports")) calls.push("export");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await addSegment(page);
  await openExport(page);
  const create = page.getByRole("button", { name: "Create clips" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByText("Export queued.")).toBeVisible();
  expect(calls).toEqual(["save", "preflight", "export"]);
  expect(savedBody?.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ exportOptions: expect.objectContaining({ mode: "separate" }) }),
    ]),
  );
});

test("save failures stop Create clips and leave it retryable", async ({ page }) => {
  let saves = 0;
  let exports = 0;
  await page.route(`${origin}/api/v1/projects/*`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saves += 1;
    if (saves === 1) return route.fulfill({ status: 500 });
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { ...body, id: "p_retry-create01", revision: 1 } });
  });
  page.on("request", (request) => {
    if (request.url().endsWith("/exports")) exports += 1;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await addSegment(page);
  await openExport(page);
  const create = page.getByRole("button", { name: "Create clips" });
  await create.click();
  await expect(
    page.getByRole("region", { name: "Export" }).getByText("Project save failed (500)."),
  ).toBeVisible();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByText("Export queued.")).toBeVisible();
  expect(saves).toBe(2);
  expect(exports).toBe(1);
});

test("conflicted saves never submit preflight or export", async ({ page }) => {
  const calls: string[] = [];
  await page.route(`${origin}/api/v1/projects/*`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    calls.push("save");
    return route.fulfill({ status: 409 });
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/exports/preflight")) calls.push("preflight");
    if (path.endsWith("/exports")) calls.push("export");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await addSegment(page);
  await openExport(page);
  await page.getByRole("button", { name: "Create clips" }).click();
  await expect(
    page.getByRole("region", { name: "Export" }).getByText(/Load latest before saving/),
  ).toBeVisible();
  expect(calls).toEqual(["save"]);
});

test("new items use the remembered destination and unavailable preferences explain fallback", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await openExport(page);
  await page.getByText("Export options", { exact: true }).click();
  await page.getByLabel("Destination").selectOption("archive");
  await page.getByRole("button", { name: "Select second.mp4" }).click();
  await openExport(page);
  await expect(page.getByLabel("Destination")).toHaveValue("archive");

  await page.evaluate(() => localStorage.setItem("videocutlist.last-destination.v1", "missing"));
  await page.reload();
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await openExport(page);
  await expect(
    page.getByText("Remembered destination is unavailable. Using Browser download."),
  ).toBeVisible();
  await expect(page.getByLabel("Destination")).toHaveValue("download");
});
