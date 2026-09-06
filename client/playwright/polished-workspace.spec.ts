import { expect, test, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:8787";
const media = {
  id: `m_${"a".repeat(43)}`,
  name: "camera.mp4",
  durationMs: 10000,
  sizeBytes: 1000,
  container: "mp4",
  etag: "v1",
  streams: {
    tracks: [
      { index: 0, type: "video", codec: "h264" },
      { index: 1, type: "audio", codec: "aac" },
    ],
  },
};
const project = {
  id: "p_polished-project01",
  schemaVersion: 2,
  name: "Saved interview",
  revision: 1,
  updatedAt: "2026-08-20T12:00:00Z",
  items: [
    {
      id: "i_aaaaaaaaaaaaaaaaaaaaaaaa",
      mediaId: media.id,
      segments: [{ startMs: 1000, endMs: 3000, label: "Opening" }],
      exportOptions: {},
    },
  ],
};
const settings = {
  revision: 1,
  schemaVersion: 1,
  roots: { media: { state: "ready" } },
  settings: {
    exportLimit: 1,
    previewGlobalLimit: 2,
    destinations: [{ id: "download", label: "Downloads", kind: "download", retention: "24h" }],
  },
};

async function chooseMedia(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await expect(page.getByLabel("In point")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "bearer", token: "test-only-token" },
    };
    Object.defineProperty(window, "MediaSource", { value: undefined });
  });
  await page.route(`${origin}/api/v1/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/media/tree"))
      return route.fulfill({ json: { folders: [], items: [media] } });
    if (path.endsWith("/media/status"))
      return route.fulfill({ json: { state: "ready_with_media", message: "Library ready." } });
    if (path.endsWith(`/media/${media.id}`)) return route.fulfill({ json: media });
    if (path.endsWith("/waveform"))
      return route.fulfill({ json: { startMs: 0, durationMs: 10000, peaks: [0.2, 0.8] } });
    if (path.endsWith("/thumbnails")) return route.fulfill({ status: 503 });
    if (path.endsWith("/projects"))
      return route.fulfill({ json: { items: [project], nextCursor: null } });
    if (path.endsWith("/batches")) return route.fulfill({ json: { items: [] } });
    if (path.endsWith("/destinations"))
      return route.fulfill({ json: { destinations: settings.settings.destinations } });
    if (path.endsWith("/settings")) return route.fulfill({ json: settings });
    if (path.endsWith("/exports/preflight"))
      return route.fulfill({ json: { allowed: true, findings: [], selection: [] } });
    if (/\/projects\/[^/]+$/.test(path)) {
      return route.fulfill({
        json:
          request.method() === "PUT"
            ? { ...request.postDataJSON(), id: path.split("/").pop(), revision: 1 }
            : project,
      });
    }
    return route.fulfill({ status: 404 });
  });
});

for (const width of [390, 700, 1049, 1050, 1051, 1280, 1717]) {
  test(`workbench geometry and settings stay usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1005 });
    await chooseMedia(page);
    const actionRow = await page.locator(".workspace-action-row").boundingBox();
    expect(actionRow!.y).toBeLessThan(20);
    expect(actionRow!.height).toBeLessThan(180);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    const timeline = await page
      .locator(".timeline-scroll")
      .evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(timeline.scroll).toBeLessThanOrEqual(timeline.width + 1);
    const tabs = await page.getByRole("tab").all();
    for (let i = 1; i < tabs.length; i++) {
      const previous = (await tabs[i - 1].boundingBox())!;
      const current = (await tabs[i].boundingBox())!;
      expect(current.x).toBeGreaterThanOrEqual(previous.x + previous.width - 1);
    }
    if (width >= 1051) {
      const timelineBox = (await page.locator(".timeline-scroll").boundingBox())!;
      expect(timelineBox.y + timelineBox.height).toBeLessThan(1005);
    }
    if (width < 1050) {
      const mediaToggle = page.locator(".workspace-action-row").getByRole("button", {
        name: /media panel/,
      });
      const segmentsToggle = page.locator(".workspace-action-row").getByRole("button", {
        name: /segments panel/,
      });
      if ((await mediaToggle.getAttribute("aria-expanded")) === "true") await mediaToggle.click();
      if ((await segmentsToggle.getAttribute("aria-expanded")) === "false")
        await segmentsToggle.click();
    }
    await page.getByRole("tab", { name: "Export", exact: true }).click();
    await page.getByText("Export options", { exact: true }).click();
    const track = page.getByRole("checkbox", { name: "Audio: aac" });
    const trackBox = (await track.boundingBox())!;
    expect(trackBox.width).toBeLessThanOrEqual(24);
    expect(trackBox.width).toBeCloseTo(trackBox.height, 0);
    await track.uncheck();
    await expect(track).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Video: h264" })).toBeDisabled();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const mute = page.getByRole("checkbox", { name: "Mute previews" });
    const muteBox = (await mute.boundingBox())!;
    expect(muteBox.width).toBeLessThanOrEqual(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.getByRole("button", { name: "Back to editor" }).click();
    await expect(page.getByRole("button", { name: "Play preview" })).toBeDisabled();
  });
}

test("editing remains usable at 200% browser zoom", async ({ page }) => {
  // A 640 CSS-pixel viewport at 2x page zoom represents a 1280px display at 200% zoom.
  await page.setViewportSize({ width: 640, height: 900 });
  await chooseMedia(page);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  const layout = await page.evaluate(() => ({
    zoom: getComputedStyle(document.documentElement).zoom,
    hasPageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  expect(layout.zoom).toBe("2");
  expect(layout.hasPageOverflow).toBe(false);

  const segmentsToggle = page.locator(".workspace-action-row").getByRole("button", {
    name: /segments panel/,
  });
  await expect(segmentsToggle).toBeVisible();
  if ((await segmentsToggle.getAttribute("aria-expanded")) === "false") await segmentsToggle.click();
  await expect(segmentsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#segments-panel")).toHaveAttribute("aria-hidden", "false");
  await page
    .locator("#segments-panel")
    .getByRole("button", { name: "Close segments panel" })
    .click();
  await expect(segmentsToggle).toBeFocused();
});

test("missing preview assets and audio remain non-blocking for editing", async ({ page }) => {
  const noAudioMedia = {
    ...media,
    streams: { tracks: [{ index: 0, type: "video", codec: "h264" }] },
  };
  await page.route(`${origin}/api/v1/media/tree`, (route) =>
    route.fulfill({ json: { folders: [], items: [noAudioMedia] } }),
  );
  await page.route(`${origin}/api/v1/media/${media.id}`, (route) =>
    route.fulfill({ json: noAudioMedia }),
  );
  await chooseMedia(page);
  await expect(page.getByText("Thumbnails unavailable; editing remains available.")).toBeVisible();
  await expect(page.getByLabel("Keyframe snapping availability")).toContainText(
    "Keyframe snapping unavailable",
  );
  await expect(page.getByRole("button", { name: "Set in" })).toBeEnabled();

  await page.getByLabel("In point").fill("00:01.000");
  await page.getByLabel("In point").press("Enter");
  await page.getByLabel("Out point").fill("00:03.000");
  await page.getByLabel("Out point").press("Enter");
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);

  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await page.getByText("Export options", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /Audio:/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create clips" })).toBeEnabled();
});

test("onboarding expands Media and Export expands the task sidebar", async ({ page }) => {
  await page.goto("/");
  const mediaToggle = page
    .locator(".workspace-action-row")
    .getByRole("button", { name: /media panel/ });
  const segmentsToggle = page
    .locator(".workspace-action-row")
    .getByRole("button", { name: /segments panel/ });
  if ((await mediaToggle.getAttribute("aria-expanded")) === "true") await mediaToggle.click();
  if ((await segmentsToggle.getAttribute("aria-expanded")) === "true") await segmentsToggle.click();
  await page.getByRole("button", { name: "Choose a video" }).click();
  await expect(page.getByRole("button", { name: "Select camera.mp4" })).toBeFocused();
  if ((await segmentsToggle.getAttribute("aria-expanded")) === "false")
    await segmentsToggle.click();
  await page.getByRole("button", { name: "Export 0 included segments" }).click();
  await expect(page.getByRole("tab", { name: "Export", exact: true })).toBeVisible();
});

test("panel layout persists and narrow drawers remain exclusive", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const mediaToggle = page.locator(".workspace-action-row").getByRole("button", {
    name: /media panel/,
  });
  const segmentsToggle = page.locator(".workspace-action-row").getByRole("button", {
    name: /segments panel/,
  });
  const mediaResizer = page.locator(".media-resizer");
  await mediaResizer.focus();
  await mediaResizer.press("ArrowRight");
  await expect(mediaResizer).toHaveAttribute("aria-valuenow", "256");
  await mediaResizer.press("Home");
  await expect(mediaResizer).toHaveAttribute("aria-valuenow", "240");
  await mediaToggle.click();
  await expect(mediaToggle).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(mediaToggle).toHaveAttribute("aria-expanded", "false");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await mediaToggle.click();
  await expect(mediaToggle).toHaveAttribute("aria-expanded", "true");
  await expect(segmentsToggle).toHaveAttribute("aria-expanded", "false");
  await segmentsToggle.click();
  await expect(segmentsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(mediaToggle).toHaveAttribute("aria-expanded", "false");
  await page
    .locator("#segments-panel")
    .getByRole("button", { name: "Close segments panel" })
    .click();
  await expect(segmentsToggle).toBeFocused();
});

test("server projects are browsable without selecting media and support pagination", async ({
  page,
}) => {
  await page.route(`${origin}/api/v1/projects?*`, (route) =>
    route.fulfill({
      json: {
        items: [
          new URL(route.request().url()).searchParams.has("cursor")
            ? { ...project, id: "p_second-project01", name: "Second project" }
            : project,
        ],
        nextCursor: new URL(route.request().url()).searchParams.has("cursor") ? null : project.id,
      },
    }),
  );
  await page.goto("/");
  await page.getByText("Browse saved projects", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved interview" })).toBeVisible();
  await page.getByRole("button", { name: "Load more projects" }).click();
  await expect(page.getByRole("button", { name: "Second project" })).toBeVisible();
  await page.getByRole("button", { name: "Saved interview" }).click();
  await expect(page.getByLabel("Project name")).toHaveValue("Saved interview");
  await page.getByRole("tab", { name: "Cuts", exact: true }).click();
  await expect(page.getByLabel("Label cut 1")).toHaveValue("Opening");
});

test("library scans show progress and can be cancelled", async ({ page }) => {
  let cancelled = false;
  await page.route(`${origin}/api/v1/media/refresh`, (route) =>
    route.fulfill({
      status: 202,
      json: { id: "j_scan123456789", state: "running", progress: 0.2, indexed: 2 },
    }),
  );
  await page.route(`${origin}/api/v1/media/import/*`, (route) => {
    if (route.request().method() === "DELETE") {
      cancelled = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json: {
        id: "j_scan123456789",
        state: cancelled ? "cancelled" : "running",
        progress: 0.4,
        indexed: 4,
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Refresh media" }).click();
  await expect(page.getByLabel("Library scan")).toContainText("4 files indexed");
  await page.getByRole("button", { name: "Cancel scan" }).click();
  await expect(page.getByLabel("Library scan")).toContainText("cancelled");
  await expect(page.getByRole("button", { name: "Refresh media" })).toBeEnabled();
});

test("detection sends sensitivity settings and rejects invalid values", async ({ page }) => {
  let body: Record<string, unknown> | undefined;
  await page.route(`${origin}/api/v1/projects/*/detections`, (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({
      status: 202,
      json: { id: "j_detect123456789", state: "succeeded", candidates: [], type: "detection" },
    });
  });
  await chooseMedia(page);
  await page.getByRole("button", { name: "Add to project" }).click();
  await page.getByRole("tab", { name: "Detection" }).click();
  await page.getByText("Detection sensitivity").click();
  await page.getByLabel("Silence threshold (dB)").fill("-35");
  await page.getByLabel("Minimum duration (ms)").fill("750");
  await page.getByLabel("Scene threshold", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Find silence" }).click();
  expect(body).toBeUndefined();
  await page.getByLabel("Scene threshold", { exact: true }).fill("0.4");
  await page.getByRole("button", { name: "Find silence" }).click();
  await expect
    .poll(() => body)
    .toMatchObject({ kind: "silence", noiseDb: -35, minDurationMs: 750, sceneThreshold: 0.4 });
});

test("queue exposes every completed output and authenticated batch downloads", async ({ page }) => {
  let authorization = "";
  let aggregateAuthorization = "";
  await page.route(`${origin}/api/v1/batches?*`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            batchId: "b_outputs12345678",
            state: "succeeded",
            progress: 1,
            jobs: [
              {
                id: "j_output12345678",
                type: "export",
                state: "succeeded",
                result: { destinationKind: "download", outputNames: ["first.mkv", "second.mkv"] },
              },
            ],
          },
          {
            batchId: "b_oldoutputs12345",
            state: "failed",
            progress: 1,
            jobs: [{ id: "j_oldoutputs12345", type: "export", state: "failed" }],
          },
        ],
      },
    }),
  );
  await page.route(`${origin}/api/v1/batches/*/download`, (route) => {
    aggregateAuthorization = route.request().headers().authorization;
    return route.fulfill({ contentType: "application/zip", body: "archive-fixture" });
  });
  await page.route(`${origin}/api/v1/jobs/*/outputs/*`, (route) => {
    authorization = route.request().headers().authorization;
    return route.fulfill({ contentType: "video/x-matroska", body: "output-fixture" });
  });
  await page.goto("/");
  const queue = page.getByRole("region", { name: "Export queue" });
  await expect(queue.getByRole("link")).toHaveCount(2);
  await expect(queue.getByText("Completed history (1)", { exact: true })).toBeVisible();
  await expect(queue.locator("details.collapse")).not.toHaveAttribute("open", "");
  await expect(queue.getByRole("button", { name: "Download all clips" })).toBeVisible();
  const archiveDownload = page.waitForEvent("download");
  await queue.getByRole("button", { name: "Download all clips" }).click();
  expect((await archiveDownload).suggestedFilename()).toBe("videocutlist-clips.zip");
  const download = page.waitForEvent("download");
  await queue.getByRole("link", { name: "Download output 2" }).click();
  expect((await download).suggestedFilename()).toBe("second.mkv");
  expect(authorization).toBe("Bearer test-only-token");
  expect(aggregateAuthorization).toBe("Bearer test-only-token");
});

test("server-folder completion names the safe destination without download actions", async ({
  page,
}) => {
  await page.route(`${origin}/api/v1/batches?*`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            batchId: "b_archive12345678",
            state: "succeeded",
            progress: 1,
            jobs: [
              {
                id: "j_archive12345678",
                type: "export",
                state: "succeeded",
                result: {
                  destinationId: "archive",
                  destinationKind: "archive",
                  outputName: "clip.mkv",
                  sizeBytes: 12,
                  retainUntil: "2026-08-21T12:00:00Z",
                },
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route(`${origin}/api/v1/destinations`, (route) =>
    route.fulfill({
      json: {
        destinations: [
          { id: "archive", label: "Review archive", kind: "archive", retention: "durable" },
        ],
      },
    }),
  );
  await page.goto("/");
  const queue = page.getByRole("region", { name: "Export queue" });
  await expect(queue.getByText("Clips created in Review archive.", { exact: true })).toBeVisible();
  await expect(queue.getByRole("button", { name: "Download all clips" })).toHaveCount(0);
  await expect(queue.getByRole("link")).toHaveCount(0);
});

test("server processing inputs are disabled during saves instead of dropping edits", async ({
  page,
}) => {
  let finish: (() => void) | undefined;
  await page.route(`${origin}/api/v1/settings`, async (route) => {
    if (route.request().method() === "PUT") {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return route.fulfill({
        json: { ...settings, revision: 2, settings: { ...settings.settings, exportLimit: 3 } },
      });
    }
    return route.fulfill({ json: settings });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByText("Server processing", { exact: true }).click();
  const concurrency = page.getByLabel("Export concurrency", { exact: true });
  await concurrency.fill("3");
  await concurrency.press("Tab");
  await expect(page.getByLabel("Preview global concurrency")).toBeDisabled();
  await expect.poll(() => Boolean(finish)).toBe(true);
  finish!();
  await expect(concurrency).toBeEnabled();
  await expect(concurrency).toHaveValue("3");
});

test("cut labels and per-row split work without invisible menu inputs", async ({ page }) => {
  await chooseMedia(page);
  await page.getByLabel("In point").fill("00:01.000");
  await page.getByLabel("In point").press("Enter");
  await page.getByLabel("Out point").fill("00:03.000");
  await page.getByLabel("Out point").press("Enter");
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Select cut 1" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByLabel("Label cut 1").fill("Opening");
  await page.getByLabel("Label cut 1").press("Tab");
  await page.getByLabel("Timeline playhead").fill("2000");
  await page.getByRole("button", { name: "Split cut 1 at playhead" }).click();
  await expect(page.getByRole("list", { name: "Selected cuts" }).getByRole("listitem")).toHaveCount(
    2,
  );
  await page.getByLabel("In point").fill("invalid");
  await page.getByLabel("In point").press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "In must be before Out" })).toBeVisible();
});

test("a multi-item JSON cut list restores as a new unsaved project", async ({ page }) => {
  await chooseMedia(page);
  await page.getByRole("button", { name: "Add to project" }).click();
  await page.getByRole("tab", { name: "Project", exact: true }).click();
  await page.getByText("Interchange", { exact: true }).click();
  page.on("dialog", (dialog) => void dialog.accept());
  const document = {
    ...project,
    items: [project.items[0], { ...project.items[0], id: "i_bbbbbbbbbbbbbbbbbbbbbbbb" }],
  };
  await page.getByLabel("Import cut list", { exact: true }).setInputFiles({
    name: "review.videocutlist.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await expect(page.getByText("Cut list imported. Save the project to keep it.")).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Project media items" }).getByRole("listitem"),
  ).toHaveCount(2);
  const saved = page.waitForRequest(
    (request) => request.method() === "PUT" && request.url().includes("/projects/"),
  );
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  expect((await saved).postDataJSON()).toMatchObject({
    revision: 0,
    name: project.name,
    items: document.items,
  });
});
