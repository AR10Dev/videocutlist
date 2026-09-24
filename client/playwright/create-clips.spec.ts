import { expect, test, type Page } from "@playwright/test";

import type { components } from "../src/generated/api";

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

async function addToProject(page: Page) {
  await page.getByRole("button", { name: "Add to project" }).click();
}

async function addSegment(page: Page, start = 100, end = 700, startNew = false) {
  if (startNew) {
    await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
    await page.keyboard.press("c");
  }
  const playhead = page.getByLabel("Timeline playhead");
  await playhead.fill(String(start));
  await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
  await page.keyboard.press("i");
  await playhead.fill(String(end));
  await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
  await page.keyboard.press("o");
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Select cut 1" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

async function openMediaChooser(page: Page) {
  const change = page.getByRole("button", { name: "Change video" });
  if (await change.isVisible()) await change.click();
}

async function openExport(page: Page) {
  const taskToggle = page.getByRole("button", { name: /editing tools/ }).first();
  if ((await taskToggle.getAttribute("aria-expanded")) === "false") await taskToggle.click();
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create clips" })).toBeVisible();
}

test("rebuilt export recovers from preflight errors and explains empty scope", async ({
  page,
}, testInfo) => {
  let preflights = 0;
  await page.route(`${origin}/api/v1/projects/*/exports/preflight`, (route) => {
    preflights++;
    return preflights === 1
      ? route.fulfill({ status: 503 })
      : route.fulfill({ json: { allowed: true, selection: [0], findings: [] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await addToProject(page);
  await openExport(page);
  await expect(
    page.getByText("Add or include a segment before creating clips.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("What to export", { exact: true }).selectOption("gaps");
  const create = page.getByRole("button", { name: "Create clips" });
  await expect(create).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("export.png"), fullPage: true });
  await create.click();
  await expect(
    page.getByText("Export preflight failed (503). Try again.", { exact: true }),
  ).toBeVisible();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(
    page.getByRole("region", { name: "Current batch" }).getByText("succeeded", { exact: true }),
  ).toBeVisible();
});

test("rebuilt detection sends source identity and completes candidate review", async ({
  page,
}, testInfo) => {
  let input: components["schemas"]["DetectionInput"] | undefined;
  let savedSegments: components["schemas"]["Segment"][] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && /\/projects\/[^/]+$/.test(new URL(request.url()).pathname))
      savedSegments = request.postDataJSON().items[0].segments;
  });
  let detection: components["schemas"]["DetectionJob"];
  await page.route(`${origin}/api/v1/jobs/j_detect-review`, (route) =>
    route.fulfill({ json: detection }),
  );
  await page.route(`${origin}/api/v1/projects/*/detections`, (route) => {
    const request = route.request().postDataJSON() as components["schemas"]["DetectionInput"];
    input = request;
    const identity = {
      mediaId: request.mediaId,
      projectId: new URL(route.request().url()).pathname.split("/")[4],
      projectRevision: request.projectRevision,
    };
    detection = {
      id: "j_detect-review",
      type: "detection",
      state: "succeeded",
      kind: "black",
      ...identity,
      candidates: [{ id: "candidate-1", ...identity, source: "black", startMs: 100, endMs: 800 }],
    };
    return route.fulfill({ status: 202, json: detection });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await addToProject(page);
  await page.getByRole("tab", { name: "Auto-detect", exact: true }).click();
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByLabel("Minimum duration (ms)").fill("750");
  await page.getByRole("button", { name: "Find black sections", exact: true }).click();
  await expect
    .poll(() => input)
    .toMatchObject({ kind: "black", minDurationMs: 750, sourceFingerprint: "v1" });
  await expect(page.getByText("Confidence", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("detection.png"), fullPage: true });
  await page.getByRole("button", { name: "Add segment", exact: true }).click();
  await page.getByRole("button", { name: "Save project from project header", exact: true }).click();
  await expect
    .poll(() => savedSegments)
    .toEqual([expect.objectContaining({ startMs: 100, endMs: 800, included: true })]);
  await expect(page.getByText("All candidates reviewed", { exact: true })).toBeVisible();
  await expect(page.getByText("No candidates found", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Close open panel", exact: true })
    .click({ position: { x: 385, y: 800 } });
  await page.getByRole("button", { name: "Show editing tools", exact: true }).click();
  await page.getByRole("tab", { name: "Auto-detect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Find black sections", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("detection-mobile.png"), fullPage: true });
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(page.getByLabel("Output arrangement", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("export-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
    Object.defineProperty(window, "MediaSource", { value: undefined });
  });
  const job: components["schemas"]["Job"] = {
    id: "j_create-clips01",
    type: "export",
    state: "queued",
    progress: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const batch: components["schemas"]["Batch"] = {
    batchId: "b_create-clips01",
    state: "queued",
    progress: 0,
    jobs: [job],
  };
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
          updatedAt: "2026-01-01T00:00:00Z",
          pathsConstrained: false,
          roots: { media: { state: "ready" } },
          settings: {
            destinations: [
              { id: "download", label: "Browser download", kind: "download", retention: "24h" },
            ],
            exportLimit: 1,
            cacheMaxBytes: 1_000_000,
            previewGlobalLimit: 2,
            previewBeforeMs: 1000,
            previewAfterMs: 1000,
            previewMaxMs: 5000,
            previewGridMs: 1000,
            mediaMaxFiles: 100,
            mediaMaxDepth: 4,
            mcpEnabled: false,
          },
        },
      });
    if (path === "/api/v1/batches" && request.method() === "GET")
      return route.fulfill({ json: { items: [] } satisfies components["schemas"]["BatchPage"] });
    if (
      (path === `/api/v1/batches/${batch.batchId}` || path === `/api/v1/jobs/${job.id}`) &&
      request.method() === "GET"
    ) {
      job.state = "succeeded";
      job.progress = 1;
      job.result = {
        outputName: "camera.mkv",
        container: "mkv",
        sizeBytes: 100,
        retainUntil: "2099-01-01T00:00:00Z",
        destinationKind: "download",
        destinationId: "download",
      };
      batch.state = "succeeded";
      batch.progress = 1;
      return route.fulfill({ json: path.includes("/batches/") ? batch : job });
    }
    if (path.endsWith("/exports/preflight"))
      return route.fulfill({ json: { allowed: true, selection: [], findings: [] } });
    if (/^\/api\/v1\/projects\/[^/]+\/exports$/.test(path))
      return route.fulfill({
        status: 202,
        json: {
          batchId: batch.batchId,
          jobs: [job],
        } satisfies components["schemas"]["BatchExportSubmission"],
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
  await addToProject(page);
  await addSegment(page);
  await openExport(page);
  const create = page.getByRole("button", { name: "Create clips" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(
    page.getByRole("region", { name: "Current batch" }).getByText("succeeded", { exact: true }),
  ).toBeVisible();
  expect(calls).toEqual(["save", "preflight", "export"]);
  expect(savedBody?.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ exportOptions: expect.objectContaining({ mode: "separate" }) }),
    ]),
  );
});

test("multi-item preflight checks every selected item before submission", async ({ page }) => {
  const calls: string[] = [];
  const preflightItems: string[][] = [];
  let exports = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "PUT" && /^\/api\/v1\/projects\/[^/]+$/.test(path)) {
      calls.push("save");
    } else if (path.endsWith("/exports/preflight")) {
      calls.push("preflight");
      const body = request.postDataJSON() as { itemIds?: string[] };
      preflightItems.push(body.itemIds ?? []);
    } else if (path.endsWith("/exports")) {
      calls.push("export");
      exports += 1;
    }
  });
  await page.route(`${origin}/api/v1/projects/*/exports/preflight`, (route) =>
    route.fulfill({
      json: {
        allowed: false,
        selection: [],
        findings: [
          {
            severity: "blocked",
            code: "unsupported_stream",
            message: "One selected item has an unsupported stream.",
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await addToProject(page);
  await addSegment(page);
  await openMediaChooser(page);
  await page.getByRole("button", { name: "Select second.mp4" }).click();
  await addToProject(page);
  await addSegment(page);
  await openExport(page);
  await page.getByRole("radio", { name: "Selected project items" }).check();
  await page.getByRole("button", { name: "Select all" }).click();
  await expect(
    page
      .getByRole("region", { name: "Server preflight" })
      .getByText("One selected item has an unsupported stream.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Create clips" })).toBeDisabled();
  expect(calls.at(-1)).toBe("preflight");
  expect(preflightItems.at(-1)).toHaveLength(2);
  expect(exports).toBe(0);
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
  await addToProject(page);
  await addSegment(page);
  await openExport(page);
  const create = page.getByRole("button", { name: "Create clips" });
  await create.click();
  await expect(
    page.getByRole("region", { name: "Export" }).getByText("Project save failed (500)."),
  ).toBeVisible();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(
    page.getByRole("region", { name: "Current batch" }).getByText("succeeded", { exact: true }),
  ).toBeVisible();
  expect(saves).toBe(2);
  expect(exports).toBe(1);
});

test("conflicted saves never submit preflight or export", async ({ page }) => {
  const calls: string[] = [];
  await page.route(`${origin}/api/v1/projects/*`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    calls.push("save");
    return route.fulfill({
      status: 409,
      json: {
        error: {
          code: "revision_conflict",
          message: "Project revision conflicts.",
          requestId: "r-conflict",
        },
      },
    });
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/exports/preflight")) calls.push("preflight");
    if (path.endsWith("/exports")) calls.push("export");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await addToProject(page);
  await addSegment(page);
  await openExport(page);
  await page.getByRole("button", { name: "Create clips" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Another client saved this project." }),
  ).toBeVisible();
  expect(calls).toEqual(["save"]);
});

test("changing export scope invalidates a prior preflight", async ({ page }) => {
  const preflightItems: string[][] = [];
  let releaseSelected: (() => void) | undefined;
  await page.route(`${origin}/api/v1/projects/*/exports/preflight`, async (route) => {
    const body = route.request().postDataJSON() as { itemIds?: string[] };
    const itemIds = body.itemIds ?? [];
    preflightItems.push(itemIds);
    if (itemIds.length < 2)
      return route.fulfill({ json: { allowed: true, selection: [], findings: [] } });
    await new Promise<void>((resolve) => {
      releaseSelected = () => {
        void route
          .fulfill({
            json: {
              allowed: false,
              selection: [],
              findings: [
                {
                  severity: "blocked",
                  code: "unsupported_stream",
                  message: "Selected scope preflight blocker.",
                },
              ],
            },
          })
          .then(resolve, resolve);
      };
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await addToProject(page);
  await addSegment(page);
  await openMediaChooser(page);
  await page.getByRole("button", { name: "Select second.mp4" }).click();
  await addToProject(page);
  await addSegment(page);
  await openExport(page);
  await page.getByRole("button", { name: "Save project from project header", exact: true }).click();
  await expect.poll(() => preflightItems.length).toBe(1);
  expect(preflightItems[0]).toHaveLength(1);
  const create = page.getByRole("button", { name: "Create clips" });
  await expect(create).toBeEnabled();

  await page.getByRole("radio", { name: "Selected project items" }).check();
  await expect(
    page.getByRole("status").filter({ hasText: "Checking export requirements…" }).first(),
  ).toBeVisible();
  await expect(create).toBeDisabled();
  await expect.poll(() => preflightItems.length).toBe(2);
  expect(preflightItems[1]).toHaveLength(2);
  releaseSelected?.();
  await expect(
    page
      .getByRole("region", { name: "Server preflight" })
      .getByText("Selected scope preflight blocker.", { exact: true }),
  ).toBeVisible();
  await expect(create).toBeDisabled();
});

test("new items use the remembered destination and unavailable preferences explain fallback", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await openExport(page);
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

test("export task keeps options and the queue together without redundant single-item scope", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await addToProject(page);
  await addSegment(page);

  await openExport(page);
  await expect(page.getByRole("group", { name: "Export scope" })).toHaveCount(0);
  await expect(page.locator(".export-plan")).toContainText("Included cuts");
  await expect(page.getByText("Filename preview", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Output arrangement")).toBeVisible();
  await expect(page.getByRole("region", { name: "Export queue" })).toBeVisible();
  await expect(page.getByText("No export jobs yet.")).toBeVisible();
});
