import { expect, test, type Page } from "@playwright/test";

const media = {
  id: "m_0123456789012345678901234567890123456789012",
  name: "camera.mp4",
  durationMs: 10_000,
  sizeBytes: 1000,
  container: "mp4",
  streams: {
    tracks: [
      { index: 0, type: "video", codec: "h264" },
      { index: 1, type: "audio", codec: "aac", language: "eng" },
      { index: 2, type: "subtitle", codec: "ass", language: "eng" },
    ],
  },
  etag: "v1",
};
const secondMedia = {
  ...media,
  id: "m_second-012345678901234567890123456789012345",
  name: "second.mp4",
};

const apiOrigin = "http://127.0.0.1:8787";
const itemId = "i_aaaaaaaaaaaaaaaaaaaaaaaa";

async function openTask(page: Page, name: "Cuts" | "Project" | "Export" | "Detection") {
  await page.getByRole("tab", { name, exact: true }).click();
}

async function loadProject(page: Page, id: string) {
  const accept = (dialog: import("@playwright/test").Dialog) =>
    void dialog.accept(dialog.type() === "prompt" ? id : undefined);
  page.on("dialog", accept);
  try {
    await page.getByRole("button", { name: "Load project" }).click();
    await page.waitForTimeout(0);
  } finally {
    page.off("dialog", accept);
  }
}

async function saveProject(page: Page) {
  await openTask(page, "Project");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText(/Project saved \(revision \d+\)\./)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
    class FakeBuffer extends EventTarget {
      updating = false;
      appendBuffer() {
        this.updating = true;
        queueMicrotask(() => {
          this.updating = false;
          this.dispatchEvent(new Event("updateend"));
        });
      }
    }
    class FakeMediaSource extends EventTarget {
      static isTypeSupported() {
        return true;
      }
      readyState = "open";
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("sourceopen")));
      }
      addSourceBuffer() {
        return new FakeBuffer();
      }
      endOfStream() {}
    }
    Object.defineProperty(window, "MediaSource", { value: FakeMediaSource });
    Object.defineProperty(URL, "createObjectURL", {
      value: () => "blob:preview",
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined });
  });
  let savedRevision = 0;
  let detectionPoll = 0;
  let detectionSequence = 0;
  let detectionProjectId = "p_demo-project";
  let detectionRevision = 1;
  await page.route(`${apiOrigin}/api/v1/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/media/status")
      return route.fulfill({
        json: { state: "ready_with_media", message: "Media library is ready." },
      });
    if (url.pathname === "/api/v1/media/tree")
      return route.fulfill({ json: { folders: [], items: [media, secondMedia] } });
    if (url.pathname === `/api/v1/media/${media.id}`) return route.fulfill({ json: media });
    if (url.pathname.endsWith("/thumbnails"))
      return route.fulfill({
        headers: { "content-type": "image/png" },
        body: "png-fixture",
      });
    if (url.pathname.endsWith("/waveform"))
      return route.fulfill({
        json: { startMs: 0, durationMs: 10000, peaks: [0.1, 0.5, 1] },
      });
    if (url.pathname.includes("/preview")) {
      const center = url.searchParams.get("centerMs") ?? "0";
      if (center === "1000") await new Promise((resolve) => setTimeout(resolve, 100));
      return route.fulfill({
        headers: {
          "content-type": "video/mp4",
          "Access-Control-Expose-Headers":
            "X-Preview-Start, X-Preview-Duration, X-Preview-Offset, X-Preview-Cache, X-Request-ID",
          "X-Preview-Start": "0",
          "X-Preview-Duration": "8000",
          "X-Preview-Offset": center,
          "X-Preview-Cache": "hit",
          "X-Request-ID": `preview-${center}`,
        },
        body: "fragment",
      });
    }
    if (url.pathname === "/api/v1/destinations")
      return route.fulfill({
        json: {
          destinations: [
            { id: "download", label: "Browser download", kind: "download", retention: "24 hours" },
          ],
        },
      });
    if (url.pathname.endsWith("/exports/preflight") && request.method() === "POST")
      return route.fulfill({ json: { allowed: true, selection: [], findings: [] } });
    if (url.pathname.endsWith("/detections") && request.method() === "POST") {
      const kind = (request.postDataJSON() as { kind?: string }).kind ?? "silence";
      const projectId = url.pathname.split("/")[4];
      detectionProjectId = projectId;
      detectionRevision = savedRevision;
      detectionPoll = 0;
      detectionSequence += 1;
      return route.fulfill({
        status: 202,
        json: {
          id: `j_detection-${kind}-${detectionSequence}`,
          type: "detection",
          state: "queued",
          mediaId: media.id,
          projectId,
          projectRevision: detectionRevision,
          kind,
        },
      });
    }
    if (url.pathname.includes("/jobs/j_detection-black") && request.method() === "GET")
      return route.fulfill({
        json: {
          id: url.pathname.split("/").pop(),
          type: "detection",
          state: "failed",
          mediaId: media.id,
          projectId: detectionProjectId,
          projectRevision: detectionRevision,
          kind: "black",
          errorCode: "detection_failed",
        },
      });
    if (url.pathname.includes("/jobs/j_detection-silence") && request.method() === "GET") {
      detectionPoll += 1;
      if (detectionPoll === 1)
        return route.fulfill({
          json: {
            id: url.pathname.split("/").pop(),
            type: "detection",
            state: "running",
            mediaId: media.id,
            projectId: detectionProjectId,
            projectRevision: detectionRevision,
            kind: "silence",
          },
        });
      return route.fulfill({
        json: {
          id: url.pathname.split("/").pop(),
          type: "detection",
          state: "succeeded",
          mediaId: media.id,
          projectId: detectionProjectId,
          projectRevision: detectionRevision,
          kind: "silence",
          candidates: [
            {
              id: "c_detection-1",
              mediaId: media.id,
              projectId: detectionProjectId,
              projectRevision: detectionRevision,
              startMs: 1000,
              endMs: 1500,
              source: "silence",
              confidence: 0.9,
            },
          ],
        },
      });
    }
    if (url.pathname.includes("/jobs/j_detection-") && request.method() === "DELETE")
      return route.fulfill({ status: 204 });
    if (request.method() === "GET")
      return route.fulfill({
        json: {
          id: "p_demo-project",
          revision: 4,
          schemaVersion: 2,
          name: "Demo project",
          updatedAt: "2026-08-20T12:00:00Z",
          items: [
            {
              id: itemId,
              mediaId: media.id,
              segments: [{ startMs: 100, endMs: 700, label: "restored" }],
              editorState: { playheadMs: 700, zoom: 1, muted: false },
              exportOptions: {},
            },
          ],
        },
      });
    if (request.method() === "PUT") {
      if (url.pathname.endsWith("p_conflict-id1"))
        return route.fulfill({
          status: 409,
          json: {
            error: { code: "conflict", message: "stale", requestId: "r" },
          },
        });
      savedRevision += 1;
      const savedProjectId = url.pathname.split("/")[4];
      const body = request.postDataJSON();
      return route.fulfill({
        json: {
          ...body,
          id: savedProjectId,
          revision: savedRevision,
          updatedAt: "2026-08-20T12:00:00Z",
        },
      });
    }
    return route.fulfill({ status: 404 });
  });
});

test("desktop and narrow layouts keep the explorer and primary actions reachable", async ({
  page,
}) => {
  for (const width of [1280, 600]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Media", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /camera.mp4/ }).click();
    await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add segment" })).toBeVisible();
  }
});

test("desktop workbench fixes the viewport and lets both sidebars resize and scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set out" }).click();

  const layout = await page.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    return {
      documentFits: document.documentElement.scrollHeight === document.documentElement.clientHeight,
      bodyOverflow: getComputedStyle(document.body).overflow,
      leftResize: style(".left-sidebar").resize,
      leftOverflow: style(".left-sidebar").overflowY,
      rightResize: style(".task-panel").resize,
      rightOverflow: style(".task-panel").overflowY,
      timelineCursor: style(".timeline-visual").cursor,
      markerCursor: style(".timeline-in").cursor,
    };
  });

  expect(layout).toEqual({
    documentFits: true,
    bodyOverflow: "hidden",
    leftResize: "horizontal",
    leftOverflow: "auto",
    rightResize: "horizontal",
    rightOverflow: "auto",
    timelineCursor: "default",
    markerCursor: "ew-resize",
  });
});

test("task tabs expose selection, association, and keyboard navigation", async ({ page }) => {
  await page.goto("/");
  const detection = page.getByRole("tab", { name: "Detection", exact: true });
  await expect(detection).toBeDisabled();
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await expect(detection).toBeEnabled();
  const cuts = page.getByRole("tab", { name: "Cuts", exact: true });
  const project = page.getByRole("tab", { name: "Project", exact: true });
  const exportTab = page.getByRole("tab", { name: "Export", exact: true });
  await expect(cuts).toHaveAttribute("aria-selected", "true");
  await expect(cuts).toHaveAttribute("aria-controls", "cuts-tabpanel");
  await cuts.press("ArrowRight");
  await expect(project).toBeFocused();
  await project.press("ArrowRight");
  await expect(exportTab).toBeFocused();
  await expect(exportTab).toHaveAttribute("aria-selected", "true");
  await exportTab.press("ArrowRight");
  await expect(detection).toBeFocused();
  await expect(detection).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Detection" })).toBeVisible();
});

test("segment rows show values and support reorder and removal", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  const playhead = page.getByLabel("Timeline playhead");
  for (const [start, end] of [
    [100, 700],
    [800, 900],
  ]) {
    await playhead.fill(String(start));
    await expect(playhead).toHaveValue(String(start));
    await page.getByRole("button", { name: "Set in" }).click();
    await playhead.fill(String(end));
    await expect(playhead).toHaveValue(String(end));
    await page.getByRole("button", { name: "Set out" }).click();
    await page.getByRole("button", { name: "Add segment" }).click();
  }
  const rows = page.getByRole("list", { name: "Selected cuts" }).getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("00:00.100");
  await expect(rows.nth(0)).toContainText("00:00.700");
  await rows.nth(1).getByRole("button", { name: "Move cut 2 up" }).click();
  await expect(rows.nth(0)).toContainText("00:00.800");
  await rows.nth(0).getByRole("button", { name: "Remove cut 1" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("00:00.100");
});

test("keyboard editing keeps drafts separate from active cuts and is discoverable", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  const playhead = page.getByLabel("Timeline playhead");
  const create = async (start: number, end: number) => {
    await playhead.fill(String(start));
    await page.locator("body").press("i");
    await playhead.fill(String(end));
    await page.locator("body").press("o");
    await page.locator("body").press("c");
  };

  await create(100, 700);
  await page.keyboard.press("Escape");
  await create(800, 900);
  const rows = page.getByRole("list", { name: "Selected cuts" }).getByRole("listitem");
  await expect(rows).toHaveCount(2);

  await rows.nth(0).getByRole("button", { name: "Select cut 1" }).click();
  await playhead.fill("400");
  await page.keyboard.press("i");
  await expect(page.getByLabel("In point")).toHaveValue("00:00.400");
  await playhead.fill("850");
  await page.keyboard.press("o");
  await expect(page.getByText(/overlap another cut/)).toBeVisible();

  await playhead.fill("500");
  await page.keyboard.press("b");
  await expect(rows).toHaveCount(3);
  await page.keyboard.press("Delete");
  await expect(rows).toHaveCount(2);
  await page.keyboard.press("Control+z");
  await expect(rows).toHaveCount(3);
  await page.keyboard.press("Control+y");
  await expect(rows).toHaveCount(2);

  await page.keyboard.press("Shift+/");
  await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
  await expect(page.getByText("Preview selected segments", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toHaveCount(0);
});

test("active, looping, and ordered segment preview use bounded modes", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  const playhead = page.getByLabel("Timeline playhead");
  const create = async (start: number, end: number) => {
    await playhead.fill(String(start));
    await page.locator("body").press("i");
    await playhead.fill(String(end));
    await page.locator("body").press("o");
    await page.locator("body").press("c");
  };
  await create(100, 700);
  await page.keyboard.press("Escape");
  await create(800, 1200);

  const video = page.getByLabel("Preview player");
  await video.evaluate((element) => {
    const player = element as HTMLVideoElement;
    player.play = () => Promise.resolve();
    player.pause = () => undefined;
  });
  const firstRow = page.getByRole("list", { name: "Selected cuts" }).getByRole("listitem").nth(0);
  await firstRow.getByRole("button", { name: "Play cut 1" }).click();
  await expect(video).toHaveAttribute("data-playback-mode", "active-segment");
  await expect(video).toHaveAttribute("data-playback-intent", "playing");
  await expect(video).toHaveAttribute("data-preview-offset", "100");
  await video.evaluate((element) => {
    const player = element as HTMLVideoElement;
    player.currentTime = 0.7;
    player.dispatchEvent(new Event("timeupdate"));
  });
  await expect(playhead).toHaveValue("700");
  await expect(video).toHaveAttribute("data-playback-intent", "paused");

  await firstRow.getByRole("button", { name: "Loop cut 1" }).click();
  await expect(video).toHaveAttribute("data-playback-mode", "active-segment-loop");
  await expect(video).toHaveAttribute("data-preview-offset", "100");
  await video.evaluate((element) => {
    const player = element as HTMLVideoElement;
    player.currentTime = 0.7;
    player.dispatchEvent(new Event("timeupdate"));
  });
  await expect(playhead).toHaveValue("100");
  await expect(video).toHaveAttribute("data-playback-intent", "playing");

  await page.getByRole("button", { name: "Preview selected segments" }).click();
  await expect(video).toHaveAttribute("data-playback-mode", "ordered-segments");
  await expect(video).toHaveAttribute("data-playback-intent", "playing");
});

test("header distinguishes unsaved, dirty, and saved project states", async ({ page }) => {
  await page.goto("/");
  const status = page.locator("header").getByLabel("Project status");
  await expect(status).toContainText("Untitled project");
  await expect(status).toContainText("Unsaved");
  await expect(status).not.toContainText("Not saved");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await saveProject(page);
  await expect(status).toContainText("Untitled project");
  await expect(status).toContainText("Saved");
  await page.getByLabel("Timeline playhead").fill("200");
  await expect(status).toContainText("Saved");
});

test("browser theme selection persists and keeps focusable controls readable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const theme = page.getByLabel("Theme");
  await theme.selectOption("cmyk");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "cmyk");
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Theme")).toHaveValue("cmyk");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "cmyk");
  await page.getByLabel("Theme").focus();
  await expect(page.getByLabel("Theme")).toBeFocused();
  await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Export defaults" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Media library" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Destinations" })).toBeVisible();
  await expect(page.getByText("Server processing").locator("..")).not.toHaveAttribute("open", "");
  await expect(page.getByText("Diagnostics").locator("..")).not.toHaveAttribute("open", "");
  await expect(page.getByText("Settings revision 1")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Settings" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to editor" })).toBeVisible();
});

test("edits independent project items and submits a durable batch", async ({ page }) => {
  let savedBody: Record<string, unknown> | undefined;
  let exportBody: Record<string, unknown> | undefined;
  let submitted = false;
  const batch = {
    batchId: "b_batch-edit01",
    projectId: "p_batch-edit01",
    projectRevision: 1,
    state: "queued",
    progress: 0,
    jobs: [
      {
        id: "j_batch-edit01",
        batchId: "b_batch-edit01",
        projectItemId: itemId,
        mediaLabel: "camera.mp4",
        type: "export",
        state: "queued",
        progress: 0,
      },
    ],
  };
  await page.route(`${apiOrigin}/api/v1/media/${secondMedia.id}`, (route) =>
    route.fulfill({ json: secondMedia }),
  );
  await page.route(`${apiOrigin}/api/v1/projects/*`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    savedBody = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      json: {
        ...savedBody,
        id: "p_batch-edit01",
        revision: 1,
        updatedAt: "2026-08-20T12:00:00Z",
      },
    });
  });
  await page.route(`${apiOrigin}/api/v1/batches**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json: path === "/api/v1/batches" ? { items: submitted ? [batch] : [] } : batch,
    });
  });
  await page.route(`${apiOrigin}/api/v1/projects/*/exports`, (route) => {
    exportBody = route.request().postDataJSON() as Record<string, unknown>;
    submitted = true;
    return route.fulfill({ status: 202, json: batch });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await page.getByRole("button", { name: "Add segment" }).click();

  await page.getByRole("button", { name: /second.mp4/ }).click();
  await page.getByLabel("Timeline playhead").fill("200");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("800");
  await page.getByRole("button", { name: "Set out" }).click();
  await page.getByRole("button", { name: "Add segment" }).click();

  await openTask(page, "Project");
  const projectItems = page.getByRole("list", { name: "Project media items" });
  await projectItems.getByRole("button", { name: "camera.mp4", exact: true }).click();
  await openTask(page, "Cuts");
  await expect(page.getByRole("list", { name: "Selected cuts" })).toContainText("00:00.100");
  await expect(page.getByRole("list", { name: "Selected cuts" })).not.toContainText("00:00.200");
  await openTask(page, "Project");
  await page.getByRole("button", { name: "Move second.mp4 up" }).click();
  await page.getByRole("button", { name: "Save project" }).click();
  await expect.poll(() => savedBody).toBeTruthy();
  const items = savedBody?.items as Array<{
    mediaId: string;
    segments: Array<{ startMs: number }>;
  }>;
  expect(items.map((item) => item.mediaId)).toEqual([secondMedia.id, media.id]);
  expect(items.map((item) => item.segments[0]?.startMs)).toEqual([200, 100]);

  await openTask(page, "Export");
  await expect(page.getByLabel("Export summary")).toContainText("2 items · 2 segments · 00:01.200");
  await page.getByText("Export options", { exact: true }).click();
  await page.getByLabel("Mode").selectOption("separate");
  await expect(page.getByText("Save the project before exporting.")).toBeVisible();
  await saveProject(page);
  await openTask(page, "Export");
  await page.getByRole("button", { name: /^Export (item|\d+ items)$/ }).click();
  await expect.poll(() => exportBody).toBeTruthy();
  const exportedItems = savedBody?.items as Array<{
    mediaId: string;
    exportOptions: { mode?: string };
  }>;
  expect(exportedItems.find((item) => item.mediaId === media.id)?.exportOptions.mode).toBe(
    "separate",
  );
  expect(exportBody?.itemIds).toBeUndefined();
  await expect(page.getByRole("heading", { name: "Export queue" })).toBeVisible();
  await expect(page.getByText(/camera.mp4 · queued/)).toBeVisible();
});

test("restores the durable queue and retries a failed child as a new job", async ({ page }) => {
  const failedBatch = {
    batchId: "b_failedqueue01",
    projectId: "p_batch-edit01",
    projectRevision: 3,
    state: "failed",
    progress: 1,
    jobs: [
      {
        id: "j_failedqueue01",
        batchId: "b_failedqueue01",
        projectItemId: itemId,
        mediaLabel: "camera.mp4",
        type: "export",
        state: "failed",
        progress: 1,
        errorCode: "source_changed",
      },
    ],
  };
  const retryBatch = {
    ...failedBatch,
    batchId: "b_retryqueue001",
    state: "queued",
    progress: 0,
    jobs: [
      {
        ...failedBatch.jobs[0],
        id: "j_retryqueue001",
        batchId: "b_retryqueue001",
        state: "queued",
        progress: 0,
        errorCode: undefined,
      },
    ],
  };
  let retried = false;
  await page.route(`${apiOrigin}/api/v1/batches**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/batches/b_retryqueue001") return route.fulfill({ json: retryBatch });
    return route.fulfill({ json: { items: retried ? [retryBatch, failedBatch] : [failedBatch] } });
  });
  await page.route(`${apiOrigin}/api/v1/jobs/j_failedqueue01/retry`, (route) => {
    retried = true;
    return route.fulfill({ status: 202, json: retryBatch });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Export queue" })).toBeVisible();
  await expect(page.getByText("b_failedqueue01", { exact: false })).toHaveCount(0);
  await expect(page.getByText(/camera.mp4 · failed · 100% · source_changed/)).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => retried).toBe(true);
  await expect(page.getByRole("article", { name: "Export batch 1" })).toBeVisible();
  await expect(page.getByText("b_retryqueue001", { exact: false })).toHaveCount(0);
});

test("reload restores the active project and permits child and batch cancellation", async ({
  page,
}) => {
  const queuedBatch = {
    batchId: "b_restorequeue01",
    projectId: "p_demo-project",
    projectRevision: 4,
    state: "queued",
    progress: 0,
    jobs: [
      {
        id: "j_restorequeue01",
        batchId: "b_restorequeue01",
        projectItemId: itemId,
        mediaLabel: "camera.mp4",
        type: "export",
        state: "queued",
        progress: 0,
      },
    ],
  };
  let childCancelled = false;
  let batchCancelled = false;
  await page.addInitScript(() =>
    localStorage.setItem("videocutlist.active-project.v2", "p_demo-project"),
  );
  await page.route(`${apiOrigin}/api/v1/batches**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "DELETE") {
      batchCancelled = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json: path === "/api/v1/batches" ? { items: [queuedBatch] } : queuedBatch,
    });
  });
  await page.route(`${apiOrigin}/api/v1/jobs/j_restorequeue01`, (route) => {
    if (route.request().method() === "DELETE") childCancelled = true;
    return route.fulfill({ status: 204 });
  });

  await page.goto("/");
  await expect(page.getByLabel("Preview player")).toBeVisible();
  await openTask(page, "Project");
  const projectDetails = page.locator("details").filter({ hasText: "Project details" });
  await expect(projectDetails).toBeVisible();
  await expect(projectDetails).not.toHaveAttribute("open", "");
  const restored = page.getByRole("article", { name: "Export batch 1" });
  await restored.getByRole("button", { name: "Cancel job" }).click();
  await expect.poll(() => childCancelled).toBe(true);
  await restored.getByRole("button", { name: "Cancel batch" }).click();
  await expect.poll(() => batchCancelled).toBe(true);
});

test("explains server-mounted setup when the library is empty", async ({ page }) => {
  await page.route(`${apiOrigin}/api/v1/media/status`, (route) =>
    route.fulfill({ json: { state: "ready_empty", message: "No supported media was found." } }),
  );
  await page.route(`${apiOrigin}/api/v1/media/tree`, (route) =>
    route.fulfill({ json: { folders: [], items: [] } }),
  );

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Media", exact: true })).toBeVisible();
  await expect(page.getByText("No supported media was found.")).toBeVisible();
  await expect(page.getByText(/Mount supported media, then Refresh to index it/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project" })).toBeVisible();
});

test("keeps the inspector contextual until media is selected", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Project" })).toBeVisible();
  await expect(
    page.getByText("Choose a video from the Media library to start a project."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Export", exact: true })).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Detection" })).not.toBeVisible();
  await expect(page.getByText("Default cut strategy")).not.toBeVisible();
  await expect(page.getByText("Default filename template")).not.toBeVisible();

  await page.getByRole("button", { name: /camera.mp4/ }).click();

  await expect(page.getByRole("heading", { name: "Cuts" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Export", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Detection", exact: true })).toBeVisible();
});

test("detection polls, presents candidates, and supports reject and accept", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await openTask(page, "Detection");
  await page.getByRole("button", { name: "Find silence" }).click();
  await expect(page.getByText("Detection running.")).toBeVisible();
  await expect(page.getByText(/1 candidates found/)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("Candidate dismissed.")).toBeVisible();
  await page.getByRole("button", { name: "Find silence" }).click();
  await expect(page.getByText(/1 candidates found/)).toBeVisible();
  await page
    .getByLabel("Detection candidates")
    .getByRole("button", { name: "Add segment" })
    .click();
  await expect(page.getByText("Candidate accepted; save the project to persist it.")).toBeVisible();
  await openTask(page, "Cuts");
  await expect(page.getByText(/1 selected/)).toBeVisible();
});

test("detection can be cancelled and reports failed jobs", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await openTask(page, "Detection");
  await page.getByRole("button", { name: "Find silence" }).click();
  await expect(page.getByRole("button", { name: "Cancel detection" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel detection" }).click();
  await expect(page.getByText("Detection cancelled.")).toBeVisible();
  await page.getByRole("button", { name: "Find black frames" }).click();
  await expect(page.getByText("Detection failed: detection_failed.")).toBeVisible();
});

test("clears detection results when media context changes", async ({ page }) => {
  let pollStartedResolve!: () => void;
  const pollStarted = new Promise<void>((resolve) => {
    pollStartedResolve = resolve;
  });
  let releasePollResolve!: () => void;
  const releasePoll = new Promise<void>((resolve) => {
    releasePollResolve = resolve;
  });
  await page.route(`${apiOrigin}/api/v1/jobs/j_detection-silence-*`, async (route) => {
    pollStartedResolve();
    await releasePoll;
    await route.fulfill({
      json: {
        id: "j_detection-silence",
        type: "detection",
        state: "succeeded",
        mediaId: media.id,
        projectId: "p_demo-project",
        projectRevision: 0,
        kind: "silence",
        candidates: [
          {
            id: "stale-candidate",
            mediaId: media.id,
            projectId: "p_demo-project",
            projectRevision: 0,
            startMs: 1000,
            endMs: 1500,
            source: "silence",
            confidence: 0.9,
          },
        ],
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await openTask(page, "Detection");
  await page.getByRole("button", { name: "Find silence" }).click();
  await expect(page.getByRole("button", { name: "Cancel detection" })).toBeVisible();
  await pollStarted;
  await page.getByRole("button", { name: /second.mp4/ }).click();
  await expect(page.getByRole("button", { name: "Cancel detection" })).toHaveCount(0);
  await expect(page.getByText(/candidates found/)).toHaveCount(0);
  releasePollResolve();
  await expect(page.getByText(/candidates found/)).toHaveCount(0);
});

test("loads timeline assets for the visible range and keeps editing available on media changes", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/thumbnails") || request.url().includes("/waveform"))
      requests.push(request.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await expect(page.getByRole("group", { name: /Timeline/ })).toBeVisible();
  await expect(page.getByText("No cuts selected.", { exact: true })).toBeVisible();
  await expect.poll(() => requests.some((url) => url.includes("/thumbnails?"))).toBeTruthy();
  await expect.poll(() => requests.some((url) => url.includes("/waveform?"))).toBeTruthy();
  const initialDuration = Number(
    new URL(requests.find((url) => url.includes("/waveform?"))!).searchParams.get("durationMs"),
  );
  expect(initialDuration).toBe(10_000);
  await expect(page.locator("canvas.timeline-canvas")).toBeVisible();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect
    .poll(() =>
      requests.some(
        (url) =>
          url.includes("/waveform?") &&
          Number(new URL(url).searchParams.get("durationMs")) < initialDuration,
      ),
    )
    .toBeTruthy();
  await page.locator(".timeline-scroll").evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() =>
      requests.some(
        (url) => url.includes("/waveform?") && Number(new URL(url).searchParams.get("startMs")) > 0,
      ),
    )
    .toBeTruthy();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /second.mp4/ }).click();
  await expect(page.locator("canvas.timeline-canvas")).toHaveCount(1);
});

test("MVP browser behavior: list, metadata, settle, cancel, offset, markers, restore, and stale protection", async ({
  page,
}) => {
  const requestOrigins: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/")) requestOrigins.push(new URL(request.url()).origin);
  });
  await page.goto("/");
  expect(new URL(page.url()).origin).toBe("http://127.0.0.1:5173");
  await expect(page.getByRole("button", { name: /camera.mp4/ })).toBeVisible(); // 1 media list loads
  await page.getByRole("button", { name: /camera.mp4/ }).click();

  const playhead = page.getByLabel("Timeline playhead");
  await expect(playhead).toHaveAttribute("max", "10000"); // 2 metadata loads
  await playhead.fill("1000");
  await expect(page.getByText("Loading preview…")).not.toBeVisible();
  await page.waitForTimeout(220);
  await expect(page.getByText("Loading preview…")).toBeVisible(); // 3 request waits for the 200 ms settle debounce
  await playhead.fill("2000");
  await expect(page.getByLabel("Preview player")).toHaveAttribute("data-preview-offset", "2000"); // 4 stale request is cancelled/ignored; 5 preview begins; 6 returned offset is used

  await playhead.fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await playhead.fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await page.getByRole("button", { name: "Add segment" }).click();
  await expect(page.getByRole("list", { name: "Selected cuts" })).toContainText("00:00.100");
  await expect(page.getByRole("list", { name: "Selected cuts" })).toContainText("00:00.700");
  await saveProject(page); // 7 markers save

  await loadProject(page, "p_demo-project");
  await expect(page.getByText("Project loaded.")).toBeVisible(); // 8 project restores after reload
  await openTask(page, "Cuts");
  await expect(page.getByLabel("Label cut 1")).toHaveValue("restored");
  expect(requestOrigins).not.toHaveLength(0);
  expect(requestOrigins).toEqual(expect.arrayContaining([apiOrigin]));
  expect(new Set(requestOrigins)).toEqual(new Set([apiOrigin]));
});

test("keeps playback position, markers, and undo history synchronized", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.waitForTimeout(300);

  await page.getByLabel("Preview player").evaluate((video) => {
    const player = video as HTMLVideoElement;
    player.currentTime = 2.5;
    player.dispatchEvent(new Event("timeupdate"));
  });
  await expect(page.getByLabel("Timeline playhead")).toHaveValue("2500");
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  await page.getByRole("button", { name: "Set in" }).click();
  await expect(page.getByLabel("In point")).toHaveValue("00:02.500");
});

test("shows a safe preview failure and maps markers from the watched preview", async ({ page }) => {
  await page.unroute(`${apiOrigin}/api/v1/**`);
  await page.route(`${apiOrigin}/api/v1/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/media/tree")
      return route.fulfill({ json: { folders: [], items: [media] } });
    if (url.pathname === `/api/v1/media/${media.id}`) return route.fulfill({ json: media });
    if (url.pathname.endsWith("/preview"))
      return route.fulfill({
        headers: {
          "content-type": "video/mp4",
          "Access-Control-Expose-Headers":
            "X-Preview-Start, X-Preview-Duration, X-Preview-Offset, X-Preview-Cache, X-Request-ID",
          "X-Preview-Start": "1000",
          "X-Preview-Duration": "8000",
          "X-Preview-Offset": "250",
        },
        body: "fragment",
      });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await expect(page.getByLabel("Preview player")).toHaveAttribute("data-preview-offset", "250");
  await page.getByLabel("Preview player").evaluate((video) => {
    const player = video as HTMLVideoElement;
    player.currentTime = 0.5;
    player.dispatchEvent(new Event("timeupdate"));
  });
  await page.getByRole("button", { name: "Set in" }).click();
  await expect(page.getByLabel("In point")).toHaveValue("00:01.500");
});

test("mutes in the browser without rebuilding the server preview", async ({ page }) => {
  let previewRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/preview")) previewRequests += 1;
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await expect.poll(() => previewRequests).toBe(1);
  await expect(page.getByText("Loading preview…")).not.toBeVisible();
  const requestsBeforeMute = previewRequests;

  await page.getByRole("button", { name: "Mute preview" }).click();
  await expect(page.getByLabel("Preview player")).toHaveJSProperty("muted", true);
  await page.waitForTimeout(300);

  expect(previewRequests).toBe(requestsBeforeMute);
});

test("keeps an exact timeline seek while the paused preview settles", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  const playhead = page.getByLabel("Timeline playhead");
  await playhead.fill("2000");
  await expect(page.getByLabel("Preview player")).toHaveAttribute("data-preview-offset", "2000");

  await page.getByLabel("Preview player").evaluate((video) => {
    const player = video as HTMLVideoElement;
    player.pause();
    player.currentTime = 1.95;
    player.dispatchEvent(new Event("seeking"));
    player.dispatchEvent(new Event("seeked"));
  });

  await expect(playhead).toHaveValue("2000");
});

test("renews whole-media playback without dirtying viewing state and honors pause", async ({
  page,
}) => {
  const previewRequests: string[] = [];
  let renewalStartedResolve!: () => void;
  const renewalStarted = new Promise<void>((resolve) => {
    renewalStartedResolve = resolve;
  });
  let releaseRenewal!: () => void;
  const renewalReleased = new Promise<void>((resolve) => {
    releaseRenewal = resolve;
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/preview")) previewRequests.push(request.url());
  });
  await page.route(`${apiOrigin}/api/v1/media/${media.id}/preview**`, async (route) => {
    const url = new URL(route.request().url());
    const center = url.searchParams.get("centerMs") ?? "0";
    if (center === "7250") {
      renewalStartedResolve();
      await renewalReleased;
    }
    return route.fulfill({
      headers: {
        "content-type": "video/mp4",
        "Access-Control-Expose-Headers":
          "X-Preview-Start, X-Preview-Duration, X-Preview-Offset, X-Preview-Cache, X-Request-ID",
        "X-Preview-Start": "0",
        "X-Preview-Duration": "8000",
        "X-Preview-Offset": center,
        "X-Preview-Cache": "hit",
        "X-Request-ID": `preview-${center}`,
      },
      body: "fragment",
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await saveProject(page);
  const video = page.getByLabel("Preview player");
  await video.evaluate((element) => {
    const player = element as HTMLVideoElement;
    player.play = () => Promise.resolve();
    player.pause = () => undefined;
  });
  await expect.poll(() => previewRequests.length).toBe(1);
  await expect(video).toHaveAttribute("data-playback-mode", "whole-media");
  await page.getByLabel("Preview volume").fill("0.35");
  await page.getByRole("button", { name: "Mute preview" }).click();
  await page.getByRole("button", { name: "Play preview" }).click();
  await expect(video).toHaveAttribute("data-playback-intent", "playing");
  await video.evaluate((element) => {
    const player = element as HTMLVideoElement;
    player.currentTime = 7.25;
    player.dispatchEvent(new Event("timeupdate"));
  });
  await expect(page.getByLabel("Timeline playhead")).toHaveValue("7250");
  await renewalStarted;
  await expect(page.getByRole("button", { name: "Pause preview" })).toBeVisible();
  await page.getByRole("button", { name: "Pause preview" }).click();
  await expect(page.getByRole("button", { name: "Play preview" })).toBeVisible();
  releaseRenewal();
  await expect.poll(() => previewRequests.length).toBe(2);
  await expect(video).toHaveAttribute("data-preview-offset", "7250");
  await expect(video).toHaveAttribute("data-playback-intent", "paused");
  expect(await video.evaluate((element) => (element as HTMLVideoElement).volume)).toBe(0.35);
  await expect(video).toHaveJSProperty("muted", true);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.locator("header").getByLabel("Project status")).toContainText("Saved");
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  expect(new URL(previewRequests[1]).searchParams.get("centerMs")).toBe("7250");
});

test("stops whole-media playback at media duration after the final window", async ({ page }) => {
  const previewRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/preview")) previewRequests.push(request.url());
  });
  await page.route(`${apiOrigin}/api/v1/media/${media.id}/preview**`, (route) => {
    const url = new URL(route.request().url());
    const center = url.searchParams.get("centerMs") ?? "0";
    const finalWindow = center === "8000";
    return route.fulfill({
      headers: {
        "content-type": "video/mp4",
        "Access-Control-Expose-Headers":
          "X-Preview-Start, X-Preview-Duration, X-Preview-Offset, X-Preview-Cache, X-Request-ID",
        "X-Preview-Start": finalWindow ? "6000" : "0",
        "X-Preview-Duration": finalWindow ? "4000" : "8000",
        "X-Preview-Offset": finalWindow ? "2000" : center,
        "X-Preview-Cache": "hit",
        "X-Request-ID": `preview-${center}`,
      },
      body: "fragment",
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  const video = page.getByLabel("Preview player");
  await video.evaluate((element) => {
    const player = element as HTMLVideoElement;
    player.play = () => Promise.resolve();
    player.pause = () => undefined;
  });
  await expect.poll(() => previewRequests.length).toBe(1);
  await page.getByRole("button", { name: "Play preview" }).click();
  await video.evaluate((element) => {
    const player = element as HTMLVideoElement;
    player.currentTime = 8;
    player.dispatchEvent(new Event("timeupdate"));
  });
  await expect.poll(() => previewRequests.length).toBe(2);
  await expect(video).toHaveAttribute("data-preview-offset", "2000");
  await video.evaluate((element) => {
    const player = element as HTMLVideoElement;
    player.currentTime = 4;
    player.dispatchEvent(new Event("timeupdate"));
    player.dispatchEvent(new Event("ended"));
  });
  await expect(page.getByRole("button", { name: "Play preview" })).toBeVisible();
  await expect(page.getByLabel("Timeline playhead")).toHaveValue("10000");
  await expect(video).toHaveAttribute("data-playback-intent", "paused");
  expect(previewRequests).toHaveLength(2);
});

test("pauses and explains a failed whole-media renewal", async ({ page }) => {
  const previewRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/preview")) previewRequests.push(request.url());
  });
  await page.route(`${apiOrigin}/api/v1/media/${media.id}/preview**`, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("centerMs") === "7500") return route.fulfill({ status: 500 });
    return route.fulfill({
      headers: {
        "content-type": "video/mp4",
        "Access-Control-Expose-Headers":
          "X-Preview-Start, X-Preview-Duration, X-Preview-Offset, X-Preview-Cache, X-Request-ID",
        "X-Preview-Start": "0",
        "X-Preview-Duration": "8000",
        "X-Preview-Offset": url.searchParams.get("centerMs") ?? "0",
      },
      body: "fragment",
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  const video = page.getByLabel("Preview player");
  await video.evaluate((element) => {
    const player = element as HTMLVideoElement;
    player.play = () => Promise.resolve();
    player.pause = () => undefined;
  });
  await expect.poll(() => previewRequests.length).toBe(1);
  await page.getByRole("button", { name: "Play preview" }).click();
  await video.evaluate((element) => {
    const player = element as HTMLVideoElement;
    player.currentTime = 7.5;
    player.dispatchEvent(new Event("timeupdate"));
  });
  await expect(
    page.getByText(
      "Preview request failed. Try again. Timeline markers remain available for editing.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Play preview" })).toBeVisible();
  await expect(page.getByLabel("Timeline playhead")).toHaveValue("7500");
  expect(previewRequests).toHaveLength(2);
});

test("shows a safe preview request failure", async ({ page }) => {
  await page.route(`${apiOrigin}/api/v1/media/${media.id}/preview**`, (route) =>
    route.fulfill({ status: 500 }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await expect(
    page.getByText(
      "Preview request failed. Try again. Timeline markers remain available for editing.",
    ),
  ).toBeVisible();
});

test("shows unsupported preview guidance without making a preview request", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    Object.defineProperty(window.MediaSource, "isTypeSupported", {
      value: () => false,
    });
  });
  let previewRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/preview")) previewRequests += 1;
  });
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await expect(
    page.getByText(
      "Preview is unavailable in this browser. Use the timeline controls to set markers manually.",
    ),
  ).toBeVisible();
  await page.waitForTimeout(250);
  expect(previewRequests).toBe(0);
});

test("save reports an optimistic revision conflict", async ({ page }) => {
  await page.route(`${apiOrigin}/api/v1/projects/*`, (route) =>
    route.request().method() === "PUT" ? route.fulfill({ status: 409 }) : route.fallback(),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await openTask(page, "Project");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText(/Load latest before saving/)).toBeVisible();
});

test("exports the saved segments, polls to a safe result, and shows warnings", async ({ page }) => {
  const requests: string[] = [];
  let polls = 0;
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.route(`${apiOrigin}/api/v1/projects/*/exports`, async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      mode: "merge",
      selection: "segments",
      streamIndexes: [],
      cutStrategy: "stream_copy_preferred",
      container: "mkv",
      destinationId: "download",
      filenameTemplate: "{source}-{segment}.{ext}",
    });
    await route.fulfill({
      json: {
        batchId: "b_export000001",
        jobs: [{ id: "j_export", type: "export", state: "queued", progress: 0 }],
      },
    });
  });
  await page.route(`${apiOrigin}/api/v1/jobs/j_export`, async (route) => {
    polls += 1;
    await route.fulfill({
      json:
        polls === 1
          ? { id: "j_export", type: "export", state: "running", progress: 0.5 }
          : {
              id: "j_export",
              type: "export",
              state: "succeeded",
              progress: 1,
              result: {
                outputName: "camera-cut.mkv",
                sizeBytes: 42,
                retainUntil: "2026-08-20T12:00:00Z",
                destinationKind: "download",
              },
              appliedStrategy: "stream_copy",
              verified: true,
              warnings: ["Cut may start at an earlier keyframe."],
            },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await page.getByRole("button", { name: "Add segment" }).click();
  await saveProject(page);
  await openTask(page, "Export");
  await page.getByRole("button", { name: /^Export (item|\d+ items)$/ }).click();
  await expect(page.getByText(/Export (queued|running)\./)).toBeVisible();
  await expect(page.getByRole("link", { name: "Download output 1" })).toHaveCount(0);
  await expect(page.getByText("Export complete.")).toBeVisible({
    timeout: 4_000,
  });
  expect(requests.findIndex((path) => /\/projects\/p_[^/]+$/.test(path))).toBeLessThan(
    requests.findIndex((path) => path.endsWith("/exports")),
  );
  await expect(page.getByLabel("Export result")).toContainText("camera-cut.mkv");
  await expect(page.getByLabel("Export result")).toContainText("42 bytes");
  await expect(page.getByLabel("Export result")).toContainText("Verified output");
  await expect(page.getByLabel("Export result")).not.toContainText("stream_copy");
  await expect(page.getByRole("link", { name: "Download output 1" })).toBeVisible();
  await expect(page.getByLabel("Export warnings")).toContainText("earlier keyframe");
  await expect(page.locator("main")).not.toContainText("/private/export");
});

test("reviews preflight blockers and only enables eligible downloads", async ({ page }) => {
  let requestedStreamIndexes: number[] | undefined;
  await page.route(`${apiOrigin}/api/v1/projects/*/exports/preflight`, (route) => {
    requestedStreamIndexes = route.request().postDataJSON().streamIndexes;
    return route.fulfill({
      json: {
        allowed: false,
        selection: [0, 2],
        findings: [
          {
            severity: "blocked",
            code: "unsupported_stream",
            message: "Stream 1 cannot be exported.",
          },
        ],
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await openTask(page, "Export");
  await page.getByText("Export options", { exact: true }).click();
  await expect(page.getByLabel("Destination")).toHaveValue("download");
  await expect(page.getByText("Video: h264")).toBeVisible();
  await expect(page.getByText("Audio: aac")).toBeVisible();
  await expect(page.getByText("Subtitle: ass")).toBeVisible();
  await page.getByRole("checkbox", { name: "Audio: aac" }).uncheck();
  await expect.poll(() => requestedStreamIndexes).toEqual([0, 2]);
  await expect(page.getByRole("checkbox", { name: "Video: h264" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Audio: aac" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Subtitle: ass" })).toBeChecked();
  await expect(page.getByLabel("Export summary")).toContainText("camera-1.mkv");
  await expect(page.getByText("Selected streams: 2")).toHaveCount(0);
  await expect(page.getByText("Stream 1 cannot be exported.").first()).toBeVisible();
  await expect(page.getByText(/blocked:/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Export (item|\d+ items)$/ })).toBeDisabled();
});

test("shows stable failed and capacity messages and permits retry", async ({ page }) => {
  let creates = 0;
  await page.route(`${apiOrigin}/api/v1/projects/*/exports`, async (route) => {
    creates += 1;
    if (creates === 1) return route.fulfill({ status: 429 });
    return route.fulfill({
      json: {
        batchId: "b_failed000001",
        jobs: [{ id: "j_failed", type: "export", state: "queued", progress: 0 }],
      },
    });
  });
  await page.route(`${apiOrigin}/api/v1/jobs/j_failed`, (route) =>
    route.fulfill({
      json: {
        id: "j_failed",
        type: "export",
        state: "failed",
        progress: 1,
        errorCode: "interrupted_by_restart",
        result: {
          outputName: "interrupted.mkv",
          sizeBytes: 42,
          retainUntil: "2026-08-20T12:00:00Z",
          destinationKind: "download",
        },
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await page.getByRole("button", { name: "Add segment" }).click();
  await saveProject(page);
  await openTask(page, "Export");
  const exportButton = page.getByRole("button", { name: /^Export (item|\d+ items)$/ });
  await exportButton.click();
  await expect(page.getByText("Export capacity is busy. Try again shortly.")).toBeVisible();
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  await expect(
    page.getByText("Export was interrupted by a server restart. Try again."),
  ).toBeVisible({ timeout: 3_000 });
  await expect(page.getByRole("link", { name: "Download output 1" })).toHaveCount(0);
});

test("cancels an active export without showing a path", async ({ page }) => {
  let cancelled = false;
  await page.route(`${apiOrigin}/api/v1/projects/*/exports`, (route) =>
    route.fulfill({
      json: {
        batchId: "b_cancel000001",
        jobs: [{ id: "j_cancel", type: "export", state: "queued", progress: 0 }],
      },
    }),
  );
  await page.route(`${apiOrigin}/api/v1/batches/b_cancel000001`, (route) => {
    if (route.request().method() === "DELETE") cancelled = true;
    return route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await page.getByRole("button", { name: "Add segment" }).click();
  await saveProject(page);
  await openTask(page, "Export");
  await page.getByRole("button", { name: /^Export (item|\d+ items)$/ }).click();
  await page.getByRole("button", { name: "Cancel export" }).click();
  await expect(page.getByText("Export cancelled.")).toBeVisible();
  expect(cancelled).toBe(true);
  await expect(page.locator("main")).not.toContainText("/private/export");
});

test("delayed project loads cannot replace a newer editor", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${apiOrigin}/api/v1/projects/p_race-load012`, async (route) => {
    await delayed;
    await route
      .fulfill({
        json: {
          id: "p_race-load012",
          mediaId: media.id,
          revision: 1,
          segments: [],
          uiState: { playheadMs: 0, zoom: 1, muted: false },
        },
      })
      .catch(() => {});
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await openTask(page, "Project");
  await loadProject(page, "p_race-load012");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "New project" }).click();
  release();
  await expect(page.getByRole("heading", { name: "Choose a video to begin" })).toBeVisible();
  await expect(page.getByText("Project loaded.")).toHaveCount(0);
});

test("delayed saves stay dirty and cannot launch obsolete exports", async ({ page }) => {
  let saves = 0;
  let exports = 0;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${apiOrigin}/api/v1/projects/*`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saves += 1;
    if (saves === 1) await delayed;
    return route.fulfill({
      json: {
        id: "p_save-race012",
        mediaId: media.id,
        revision: saves,
        segments: [],
        uiState: { playheadMs: 0, zoom: 1, muted: false },
      },
    });
  });
  await page.route(`${apiOrigin}/api/v1/projects/*/exports`, (route) => {
    exports += 1;
    return route.fulfill({
      json: {
        batchId: "b_newexport001",
        jobs: [{ id: "j_new", type: "export", state: "queued", progress: 0 }],
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await openTask(page, "Project");
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await page.getByRole("button", { name: "Add segment" }).click();
  await page.getByRole("button", { name: "Save project" }).click();
  await openTask(page, "Export");
  await expect(page.getByRole("button", { name: /^Export (item|\d+ items)$/ })).toBeDisabled();
  await page.getByLabel("Timeline playhead").fill("1");
  release();
  await page.waitForTimeout(50);
  expect(exports).toBe(0);
  await saveProject(page);
  await openTask(page, "Export");
  await page.getByRole("button", { name: /^Export (item|\d+ items)$/ }).click();
  await expect(page.getByText("Export queued.")).toBeVisible();
});

test("a delayed old-project save stays silent after New and the new project saves at revision zero", async ({
  page,
}) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let oldStarted!: () => void;
  const oldStart = new Promise<void>((resolve) => {
    oldStarted = resolve;
  });
  let oldCompleted!: () => void;
  const oldComplete = new Promise<void>((resolve) => {
    oldCompleted = resolve;
  });
  let newCompleted!: () => void;
  const newComplete = new Promise<void>((resolve) => {
    newCompleted = resolve;
  });
  let saves = 0;
  await page.route(`${apiOrigin}/api/v1/projects/*`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saves += 1;
    const body = route.request().postDataJSON();
    if (saves === 1) {
      oldStarted();
      await delayed;
      await route.fulfill({
        json: {
          id: "p_old-save0123",
          mediaId: media.id,
          revision: 9,
          segments: [],
          uiState: { playheadMs: 0, zoom: 1, muted: false },
        },
      });
      oldCompleted();
      return;
    }
    expect(body.revision).toBe(saves === 2 ? 0 : 1);
    const id = new URL(route.request().url()).pathname.split("/").pop();
    await route.fulfill({
      json: {
        id,
        mediaId: media.id,
        revision: saves - 1,
        segments: body.segments,
        uiState: body.uiState,
      },
    });
    if (saves === 2) newCompleted();
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await openTask(page, "Project");
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await page.getByRole("button", { name: "Add segment" }).click();
  await openTask(page, "Project");
  await page.getByRole("button", { name: "Save project" }).click();
  await oldStart;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await page.getByRole("button", { name: "Add segment" }).click();
  await openTask(page, "Project");
  await page.getByRole("button", { name: "Save project" }).click();
  await newComplete;
  release();
  await oldComplete;
  await page.getByLabel("Timeline playhead").fill("701");
  await openTask(page, "Project");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect.poll(() => saves).toBe(3);
  await expect(page.getByText("Project saved (revision 9).")).toHaveCount(0);
});

test("unmounting a deferred export save cannot start export, poll, or remember a project", async ({
  page,
  context,
}) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saveStarted!: () => void;
  const saveStart = new Promise<void>((resolve) => {
    saveStarted = resolve;
  });
  let exports = 0;
  let polls = 0;
  context.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/exports")) exports += 1;
    if (path.includes("/jobs/")) polls += 1;
  });
  await page.route(`${apiOrigin}/api/v1/projects/*`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saveStarted();
    await delayed;
    await route
      .fulfill({
        json: {
          id: "p_unmount-save12",
          mediaId: media.id,
          revision: 1,
          segments: [],
          uiState: { playheadMs: 0, zoom: 1, muted: false },
        },
      })
      .catch(() => {});
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await openTask(page, "Project");
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await page.getByRole("button", { name: "Add segment" }).click();
  await page.getByRole("button", { name: "Save project" }).click();
  await saveStart;
  await page.close();
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const next = await context.newPage();
  await next.goto("/");
  expect(exports).toBe(0);
  expect(polls).toBe(0);
  await expect
    .poll(() => next.evaluate(() => localStorage.getItem("videocutlist.recent-projects.v1")))
    .toBeNull();
  await next.close();
});

test("stale selection metadata cannot replace a refresh or newer selection status", async ({
  page,
}) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${apiOrigin}/api/v1/media/${media.id}`, async (route) => {
    await delayed;
    return route.fulfill({ status: 500 }).catch(() => {});
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /second.mp4/ }).click();
  await page.getByRole("button", { name: "Refresh media" }).click();
  release();
  await openTask(page, "Project");
  await expect(
    page.getByRole("list", { name: "Project media items" }).getByRole("button", {
      name: "second.mp4",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/Metadata request failed/)).toHaveCount(0);
});

test("refresh metadata cannot restore an old selection", async ({ page }) => {
  let refreshed = false;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${apiOrigin}/api/v1/media**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/media/refresh") {
      refreshed = true;
      return route.fulfill({ json: {} });
    }
    if (url.pathname === "/api/v1/media/tree" && route.request().method() === "GET")
      return route.fulfill({
        json: {
          folders: [],
          items: refreshed ? [secondMedia] : [media, secondMedia],
          nextCursor: null,
        },
      });
    if (url.pathname === `/api/v1/media/${media.id}` && refreshed) {
      await delayed;
      return route.fulfill({ json: media });
    }
    return route.fallback();
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByRole("button", { name: "Refresh media" }).click();
  await expect(page.getByRole("button", { name: /second.mp4/ })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /second.mp4/ }).click();
  release();
  await openTask(page, "Project");
  await expect(
    page.getByRole("list", { name: "Project media items" }).getByRole("button", {
      name: "second.mp4",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("delayed cancellation cannot overwrite a replacement export", async ({ page }) => {
  let releases!: () => void;
  const delayed = new Promise<void>((resolve) => {
    releases = resolve;
  });
  let exports = 0;
  await page.route(`${apiOrigin}/api/v1/projects/*/exports`, (route) => {
    exports += 1;
    const id = exports === 1 ? "j_old" : "j_new";
    return route.fulfill({
      json: {
        batchId: exports === 1 ? "b_oldexport001" : "b_newexport001",
        jobs: [{ id, type: "export", state: "queued", progress: 0 }],
      },
    });
  });
  await page.route(`${apiOrigin}/api/v1/jobs/j_old`, (route) =>
    route.fulfill({
      json: { id: "j_old", type: "export", state: "queued", progress: 0 },
    }),
  );
  await page.route(`${apiOrigin}/api/v1/batches/b_oldexport001`, async (route) => {
    await delayed;
    return route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await page.getByRole("button", { name: "Add segment" }).click();
  await saveProject(page);
  await openTask(page, "Export");
  await page.getByRole("button", { name: /^Export (item|\d+ items)$/ }).click();
  await expect(page.getByText("Export queued.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel export" }).click();
  await openTask(page, "Export");
  await page.getByRole("button", { name: /^Export (item|\d+ items)$/ }).click();
  await expect(page.getByText("Export queued.")).toBeVisible();
  releases();
  await expect(page.getByText("Export cancelled.")).toHaveCount(0);
});

test("new projects reset the editor and dirty changes need confirmation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  let projectLoads = 0;
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      /\/api\/v1\/projects\/p_[^/]+$/.test(new URL(request.url()).pathname)
    )
      projectLoads += 1;
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await openTask(page, "Project");
  await page.getByRole("button", { name: "Load project" }).click();
  await page.waitForTimeout(50);
  expect(projectLoads).toBe(0);
  await page.getByRole("button", { name: /second.mp4/ }).click();
  await expect(
    page.getByRole("list", { name: "Project media items" }).getByRole("button", {
      name: "second.mp4",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("list", { name: "Project media items" }).getByRole("listitem"),
  ).toHaveCount(2);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "New project" }).click();
  await expect(page.getByText("New project ready.")).not.toBeVisible();
  await expect(page.getByLabel("Preview player")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "New project" }).click();
  await expect(page.getByRole("heading", { name: "Choose a video to begin" })).toBeVisible();
  await expect(page.getByText("Project details", { exact: true })).not.toBeVisible();
});

test("load fetches project media directly and corrupt recents do not block startup", async ({
  page,
}) => {
  const outsideMedia = {
    ...media,
    id: "m_outside-page-012345678901234567890123456789",
    name: "outside.mp4",
  };
  await page.addInitScript(() =>
    localStorage.setItem("videocutlist.recent-projects.v1", "not json"),
  );
  await page.route(`${apiOrigin}/api/v1/projects/p_outside-media`, (route) =>
    route.fulfill({
      json: {
        id: "p_outside-media",
        revision: 7,
        updatedAt: "2026-01-01T00:00:00Z",
        schemaVersion: 2,
        name: "Outside media",
        items: [
          {
            id: "i_outside000001",
            mediaId: outsideMedia.id,
            segments: [{ startMs: 100, endMs: 700, label: "outside" }],
            editorState: { playheadMs: 700, zoom: 2, muted: true },
            exportOptions: {},
          },
        ],
      },
    }),
  );
  await page.route(`${apiOrigin}/api/v1/media/${outsideMedia.id}`, (route) =>
    route.fulfill({ json: outsideMedia }),
  );
  await page.goto("/");
  await expect(page.getByRole("button", { name: /camera.mp4/ })).toBeVisible();
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await openTask(page, "Project");
  await loadProject(page, "p_outside-media");
  await expect(page.getByText("Project loaded.")).toBeVisible();
  await expect(
    page.locator(".media-list").getByRole("button", { name: /outside.mp4/ }),
  ).toBeVisible();
  await expect(page.locator(".media-list")).toContainText("outside.mp4");
});

test("loads cursor pages once and removes Load more at the end", async ({ page }) => {
  await page.route(`${apiOrigin}/api/v1/media**`, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET") return route.fallback();
    if (!url.searchParams.get("cursor"))
      return route.fulfill({
        json: { folders: [], items: [media], nextCursor: "next/+=" },
      });
    expect(url.searchParams.get("cursor")).toBe("next/+=");
    return route.fulfill({
      json: { folders: [], items: [media, secondMedia], nextCursor: null },
    });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("button", { name: /second.mp4/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(
    await page.locator(".media-list").getByRole("button", { name: "Select camera.mp4" }).count(),
  ).toBeGreaterThan(0);
});

test("keeps the first page after a later-page failure and permits retry", async ({ page }) => {
  let attempts = 0;
  await page.route(`${apiOrigin}/api/v1/media**`, (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET") return route.fallback();
    if (!url.searchParams.get("cursor"))
      return route.fulfill({ json: { folders: [], items: [media], nextCursor: "next" } });
    attempts += 1;
    return route.fulfill(
      attempts === 1
        ? { status: 500 }
        : { json: { folders: [], items: [secondMedia], nextCursor: null } },
    );
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("button", { name: /camera.mp4/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toBeEnabled();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("button", { name: /second.mp4/ })).toBeVisible();
});

test("refresh replaces the first page and selected metadata", async ({ page }) => {
  const refreshed = { ...media, name: "refreshed.mp4", etag: "v2" };
  let refreshes = 0;
  await page.route(`${apiOrigin}/api/v1/media**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/media/refresh") {
      refreshes += 1;
      return route.fulfill({
        json: {
          id: "j_refresh",
          type: "media_refresh",
          state: "succeeded",
          progress: 1,
        },
      });
    }
    if (route.request().method() !== "GET") return route.fallback();
    if (url.pathname === `/api/v1/media/${media.id}`)
      return route.fulfill({ json: refreshes ? refreshed : media });
    if (url.pathname === "/api/v1/media/tree")
      return route.fulfill({
        json: { folders: [], items: refreshes ? [refreshed] : [media], nextCursor: null },
      });
    if (refreshes && (url.pathname.endsWith("/thumbnails") || url.pathname.endsWith("/waveform"))) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return route.fulfill(
        url.pathname.endsWith("/thumbnails")
          ? {
              headers: { "content-type": "image/png" },
              body: "refreshed-png-fixture",
            }
          : { json: { startMs: 0, durationMs: 10000, peaks: [0.2, 0.6] } },
      );
    }
    return route.fallback();
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await expect(page.locator("canvas.timeline-canvas")).toBeVisible();
  await page.getByRole("button", { name: "Refresh media" }).click();
  await expect(page.getByRole("button", { name: /refreshed.mp4/ })).toBeVisible();
  await expect(page.getByLabel("Selected media")).toContainText("refreshed.mp4");
  await expect(page.locator("canvas.timeline-canvas")).toHaveCount(1);
});

for (const [status, message] of [
  [403, "You are not allowed to refresh media."],
  [429, "Media refresh is already in progress. Try again shortly."],
] as const) {
  test(`refresh reports ${status}`, async ({ page }) => {
    await page.route(`${apiOrigin}/api/v1/media/refresh`, (route) => route.fulfill({ status }));
    await page.goto("/");
    const refresh = page.getByRole("button", { name: "Refresh media" });
    await refresh.click();
    await expect(page.getByText(message)).toBeVisible();
    await expect(refresh).toBeEnabled();
  });
}

test("covers the responsive workspace and keyboard editing workflow", async ({ page }) => {
  await page.route(`${apiOrigin}/api/v1/projects/*/exports`, (route) =>
    route.fulfill({
      json: {
        batchId: "b_keyboard-flow01",
        jobs: [{ id: "j_keyboard-flow01", type: "export", state: "queued", progress: 0 }],
      },
    }),
  );
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.locator("main")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
  }

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  const projectStatus = page.getByLabel("Project status");
  await expect(projectStatus).toContainText("Untitled project");
  await expect(projectStatus).toContainText("Unsaved");
  await page.getByRole("button", { name: /camera.mp4/ }).focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);

  const projectTab = page.getByRole("tab", { name: "Project" });
  const exportTab = page.getByRole("tab", { name: "Export" });
  const detectionTab = page.getByRole("tab", { name: "Detection" });
  await projectTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(exportTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Export options")).toBeVisible();
  await expect(page.getByText("Export options").locator("..")).not.toHaveAttribute("open", "");
  await page.keyboard.press("ArrowLeft");
  await expect(projectTab).toHaveAttribute("aria-selected", "true");

  await expect(page.getByLabel("Preview source range")).toHaveCount(0);
  await page.getByRole("heading", { name: "Timeline" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("i");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  const addSegment = page.getByRole("button", { name: "Add segment" });
  await expect(addSegment).toBeEnabled();
  await addSegment.focus();
  await page.keyboard.press("Enter");
  await openTask(page, "Cuts");
  await expect(page.getByRole("list", { name: "Selected cuts" })).toContainText("00:02.000");
  await openTask(page, "Project");
  await page.getByRole("button", { name: "Save project" }).focus();
  await page.keyboard.press("Enter");
  await expect(projectStatus).toContainText("Untitled project");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await exportTab.focus();
  await page.keyboard.press("Enter");
  await expect(exportTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select none" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select all" })).toHaveCount(0);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await exportTab.focus();
  await page.keyboard.press("ArrowLeft");
  await page.getByRole("button", { name: "Save project" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await exportTab.focus();
  await page.keyboard.press("Enter");
  const startExport = page.getByRole("button", { name: "Export item" });
  await expect(startExport).toBeEnabled();
  await startExport.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Export queued.")).toBeVisible();

  await detectionTab.focus();
  await page.keyboard.press("Enter");
  await expect(detectionTab).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Find silence" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Detection running.")).toBeVisible();
});

test("keeps the preview stable and exposes familiar playback controls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();

  const surface = page.locator(".preview-surface");
  const initialBounds = await surface.boundingBox();
  expect(initialBounds).not.toBeNull();

  await page.getByLabel("Timeline playhead").evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "1000";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(220);
  await expect(page.getByText("Loading preview…")).toBeVisible();
  expect(await surface.boundingBox()).toEqual(initialBounds);
  await expect(page.getByText("Loading preview…")).not.toBeVisible();
  expect(await surface.boundingBox()).toEqual(initialBounds);

  const video = page.getByLabel("Preview player");
  await video.evaluate((element) => {
    const player = element as HTMLVideoElement;
    player.play = async () => void player.dispatchEvent(new Event("play"));
    player.pause = () => void player.dispatchEvent(new Event("pause"));
  });
  await video.click();
  await expect(page.getByRole("button", { name: "Pause preview" })).toBeVisible();
  await page.getByRole("button", { name: "Pause preview" }).click();
  await expect(page.getByRole("button", { name: "Play preview" })).toBeVisible();

  await page.getByRole("button", { name: "Mute preview" }).click();
  await expect(page.getByRole("button", { name: "Unmute preview" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Next frame" }).click();
  const nextFrame = Number(await page.getByLabel("Timeline playhead").inputValue());
  expect(nextFrame).toBeGreaterThan(1000);
  await page.getByRole("button", { name: "Previous frame" }).click();
  await expect(page.getByLabel("Timeline playhead")).toHaveValue("1000");

  await page.getByLabel("Timeline playhead").fill("3000");
  await expect(page.getByLabel("Timeline playhead")).toHaveValue("3000");
  await page.getByLabel("Preview volume").fill("0.35");
  expect(await video.evaluate((element) => (element as HTMLVideoElement).volume)).toBe(0.35);

  await video.evaluate((element) => {
    (window as unknown as { fullscreenRequested: boolean }).fullscreenRequested = false;
    element.requestFullscreen = async () => {
      (window as unknown as { fullscreenRequested: boolean }).fullscreenRequested = true;
    };
  });
  await page.getByRole("button", { name: "Fullscreen preview" }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { fullscreenRequested: boolean }).fullscreenRequested,
    ),
  ).toBe(true);

  await page.getByRole("heading", { name: "VideoCutlist" }).click();
  await page.keyboard.press("ArrowRight");
  expect(Number(await page.getByLabel("Timeline playhead").inputValue())).toBeGreaterThan(3000);
  const shortcutPosition = await page.getByLabel("Timeline playhead").inputValue();
  await page.getByLabel("In point").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Timeline playhead")).toHaveValue(shortcutPosition);
  await page.getByRole("heading", { name: "VideoCutlist" }).click();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause preview" })).toBeVisible();
});

test("renders separate timeline lanes and seeks through their shared interaction area", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();

  const ruler = page.getByRole("img", { name: "Timeline ruler" });
  const thumbnails = page.getByRole("img", { name: "Thumbnail lane" });
  const waveform = page.getByRole("img", { name: "Waveform lane" });
  const [rulerBounds, thumbnailBounds, waveformBounds] = await Promise.all([
    ruler.boundingBox(),
    thumbnails.boundingBox(),
    waveform.boundingBox(),
  ]);
  expect(rulerBounds).not.toBeNull();
  expect(thumbnailBounds).not.toBeNull();
  expect(waveformBounds).not.toBeNull();
  expect(rulerBounds!.y + rulerBounds!.height).toBeLessThanOrEqual(thumbnailBounds!.y);
  expect(thumbnailBounds!.y + thumbnailBounds!.height).toBeLessThanOrEqual(waveformBounds!.y);

  const timeline = page.locator(".timeline-visual");
  const playhead = page.getByLabel("Timeline playhead");
  const bounds = await timeline.boundingBox();
  expect(bounds).not.toBeNull();
  await timeline.click({ position: { x: bounds!.width / 4, y: bounds!.height / 2 } });
  await expect.poll(async () => Number(await playhead.inputValue())).toBeGreaterThanOrEqual(2480);
  expect(Number(await playhead.inputValue())).toBeLessThanOrEqual(2520);

  const currentBounds = await timeline.boundingBox();
  const playheadBounds = await page.locator(".timeline-playhead").boundingBox();
  expect(currentBounds).not.toBeNull();
  expect(playheadBounds).not.toBeNull();
  expect(Math.abs(playheadBounds!.y - currentBounds!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(playheadBounds!.height - currentBounds!.height)).toBeLessThanOrEqual(2);

  await page.getByLabel("Timeline playhead").fill("1000");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("7000");
  await page.getByRole("button", { name: "Set out" }).click();
  const outMarker = page.locator(".timeline-out");
  const outBounds = await outMarker.boundingBox();
  expect(outBounds).not.toBeNull();
  await page.mouse.move(outBounds!.x + outBounds!.width / 2, outBounds!.y + 8);
  await page.mouse.down();
  await page.mouse.move(currentBounds!.x + (currentBounds!.width * 4) / 5, currentBounds!.y + 8, {
    steps: 3,
  });
  await page.mouse.up();
  await expect(page.locator("#timeline-description")).toContainText(/Out marker 00:08\.0/);

  await page.waitForTimeout(120);
  const inMarker = page.locator(".timeline-in");
  const markerBounds = await inMarker.boundingBox();
  const settledBounds = await timeline.boundingBox();
  expect(markerBounds).not.toBeNull();
  expect(markerBounds!.width).toBeGreaterThanOrEqual(12);
  expect(settledBounds).not.toBeNull();
  await page.mouse.move(markerBounds!.x + markerBounds!.width / 2, markerBounds!.y + 8);
  await page.mouse.down();
  await page.mouse.move(settledBounds!.x + settledBounds!.width / 5, settledBounds!.y + 8, {
    steps: 3,
  });
  await page.mouse.up();
  await expect(page.locator("#timeline-description")).toContainText(/In marker 00:02\.0/);
});

test("adds, selects, splits, and safely removes cuts with the redesigned controls", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await expect(page.getByRole("tab", { name: "Cuts" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Set an In point to begin a cut.")).toBeVisible();

  await page.getByLabel("In point").fill("00:01.000");
  await page.getByLabel("In point").press("Enter");
  await page.getByLabel("Out point").fill("00:03.000");
  await page.getByLabel("Out point").press("Enter");
  await expect(page.getByText("Pending cut duration 00:02.000.")).toBeVisible();
  await page.getByRole("button", { name: /Add cut/ }).click();
  const cuts = page.getByRole("list", { name: /Selected cuts/ }).getByRole("listitem");
  await expect(cuts).toHaveCount(1);
  await expect(cuts.first().getByRole("button", { name: "Select cut 1" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const startHandle = page.getByRole("slider", { name: "Resize cut 1 start" });
  const originalStart = Number(await startHandle.getAttribute("aria-valuenow"));
  await startHandle.press("ArrowRight");
  expect(Number(await startHandle.getAttribute("aria-valuenow"))).toBeGreaterThan(originalStart);
  await startHandle.press("ArrowLeft");

  await page.getByLabel("Timeline playhead").fill("2000");
  await page.getByRole("heading", { name: "Timeline" }).focus();
  await page.keyboard.press("b");
  await expect(cuts).toHaveCount(2);
  await page.getByRole("button", { name: /Move cut 1 down/ }).click();
  await expect(cuts.first().getByRole("button", { name: "Select cut 1" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByLabel("Label cut 2").focus();
  await page.keyboard.press("Backspace");
  await expect(cuts).toHaveCount(2);
  await page.getByRole("heading", { name: "Timeline" }).focus();
  await page.keyboard.press("Delete");
  await expect(cuts).toHaveCount(1);

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByLabel("Timeline zoom level")).toHaveText("2×");
  await expect(page.getByRole("button", { name: "Fit timeline" })).toBeVisible();
  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect(page.getByLabel("Timeline zoom level")).toHaveText("1×");
  await openTask(page, "Export");
  await page.getByText("Export options", { exact: true }).click();
  await expect(page.getByLabel(/Output arrangement/)).toContainText("Combine selected cuts");
  await expect(page.getByLabel("Processing")).toContainText("Fast copy");
  await expect(page.getByText(/not frame-exact/)).toBeVisible();
});

test("persists appearance and recovers from invalid stored values", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Theme").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.evaluate(() =>
    localStorage.setItem(
      "videocutlist.settings.v1",
      JSON.stringify({ appearance: "invalid", muted: true }),
    ),
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Theme")).toHaveValue("system");
});

test("covers theme contrast and selected task control states", async ({ page }) => {
  await page.goto("/");
  const projectTab = page.getByRole("tab", { name: "Project", exact: true });
  await expect(projectTab).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "Settings" }).click();
  const theme = page.getByLabel("Theme");
  await theme.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Back to editor" }).click();
  await expect(projectTab).toHaveCSS("font-weight", "700");
  await projectTab.focus();
  await expect(projectTab).toBeFocused();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Back to editor" }).click();
  await expect(projectTab).toHaveCSS("font-weight", "700");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Theme").selectOption("cupcake");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "cupcake");
});

test("keeps motion reduced and overflow local at a narrow viewport", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();

  await expect(page.getByRole("button", { name: "Play preview" })).toHaveCSS(
    "transition-duration",
    "0s",
  );
  const playhead = page.getByLabel("Timeline playhead");
  await playhead.fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await playhead.fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await page.getByRole("button", { name: "Add segment" }).click();
  await expect(
    page.getByRole("listitem", { name: "Cut 1" }).getByRole("button", {
      name: "Remove cut 1",
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Label cut 1")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const timelineOverflow = await page.locator(".timeline-scroll").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(timelineOverflow.scroll).toBeLessThanOrEqual(timelineOverflow.client + 1);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect
    .poll(() =>
      page
        .locator(".timeline-scroll")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    )
    .toBe(true);
});

test("returning from Settings reattaches preview and timecode follows later seeks", async ({
  page,
}) => {
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/preview?")) requests++;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await expect.poll(() => requests).toBe(1);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Back to editor" }).click();
  await expect.poll(() => requests).toBe(2);
  await expect(page.locator("video")).toHaveAttribute("src", "blob:preview");
  const timecode = page.getByRole("textbox", { name: "Timecode", exact: true });
  await timecode.fill("00:02.000");
  await timecode.press("Enter");
  await page.getByRole("button", { name: "Next frame" }).click();
  await expect(timecode).toHaveValue("00:03.000");
});
