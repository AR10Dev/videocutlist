import type * as EffectApiTypes from "../src/generated/effect-api";
import { expect, test, type Page } from "@playwright/test";
import { mediaFixture, secondMediaFixture, sseSnapshotFrame } from "./fixtures";

const origin = "http://127.0.0.1:8787";
const media = {
  ...mediaFixture,
  streams: { tracks: [{ index: 0, type: "video" as const, codec: "h264" }] },
};
const secondMedia = { ...secondMediaFixture, streams: media.streams };

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
  const workflowCalls: string[] = [];
  await page.route(`${origin}/api/v2/projects/*/exports/preflight`, (route) => {
    preflights++;
    return preflights === 1
      ? route.fulfill({
          status: 503,
          headers: { "X-Request-ID": "r-preflight-error" },
          json: {
            error: {
              code: "internal_error",
              message: "Internal server error.",
              requestId: "r-preflight-error",
            },
          },
        })
      : route.fulfill({
          json: {
            allowed: true,
            selection: [0],
            findings: [],
          } satisfies EffectApiTypes.ExportPreflight,
        });
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/exports/preflight")) workflowCalls.push("preflight");
    else if (path.endsWith("/exports")) workflowCalls.push("export");
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
  workflowCalls.length = 0;
  await create.click();
  await expect(
    page.getByText("Export preflight could not be reached. Try again.", { exact: true }),
  ).toBeVisible();
  expect(workflowCalls).not.toContain("export");
  await expect(create).toBeEnabled();
  workflowCalls.length = 0;
  await create.click();
  await expect(
    page.getByRole("region", { name: "Current batch" }).getByText("succeeded", { exact: true }),
  ).toBeVisible();
  expect(workflowCalls.slice(-2)).toEqual(["preflight", "export"]);
});

test("rebuilt detection sends source identity and completes candidate review", async ({
  page,
}, testInfo) => {
  let input: EffectApiTypes.DetectionInput | undefined;
  let savedSegments: EffectApiTypes.Project["items"][number]["segments"][number][] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && /\/projects\/[^/]+$/.test(new URL(request.url()).pathname))
      savedSegments = request.postDataJSON().items[0].segments;
  });
  let detection: EffectApiTypes.DetectionJob;
  let detectionKey: string | undefined;
  await page.route(`${origin}/api/v2/jobs/j_0123456789ab/events`, (route) => {
    const terminal = {
      ...detection,
      state: "succeeded",
      candidates: [
        {
          id: "candidate-1",
          mediaId: detection.mediaId,
          projectId: detection.projectId,
          projectRevision: detection.projectRevision,
          source: "black",
          startMs: 100,
          endMs: 800,
        },
      ],
      revision: 2,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
    };
    return route.fulfill({
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "X-Request-ID": "r-create-clips-detection",
      },
      body: sseSnapshotFrame("j_0123456789ab:2", terminal),
    });
  });
  await page.route(`${origin}/api/v2/projects/*/detections`, (route) => {
    const request = route.request().postDataJSON() as EffectApiTypes.DetectionInput;
    input = request;
    detectionKey = route.request().headers()["idempotency-key"];
    const identity = {
      mediaId: request.mediaId,
      projectId: new URL(route.request().url()).pathname.split("/")[4],
      projectRevision: request.projectRevision,
    };
    detection = {
      id: "j_0123456789ab",
      type: "detection",
      state: "queued",
      kind: "black",
      ...identity,
    };
    return route.fulfill({
      status: 202,
      headers: { "X-Request-ID": "r-create-clips-detection-submit" },
      json: detection,
    });
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
    .toMatchObject({ kind: "black", minDurationMs: 750, sourceFingerprint: media.etag });
  expect(input?.projectItemId).toMatch(/^i_[A-Za-z0-9_-]{24}$/);
  expect(input?.projectRevision).toBeGreaterThanOrEqual(1);
  expect(detectionKey).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
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
  let job: EffectApiTypes.Job = {
    id: "j_0123456789ab",
    batchId: "b_0123456789ab",
    projectId: "p_0123456789ab",
    projectRevision: 1,
    type: "export",
    state: "queued",
    revision: 1,
    progress: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  let batch: EffectApiTypes.Batch = {
    batchId: "b_0123456789ab",
    projectId: "p_0123456789ab",
    projectRevision: 1,
    state: "queued",
    progress: 0,
    jobs: [job],
  };
  await page.route(`${origin}/api/v2/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice("/api/v2".length);
    if (path === "/media/status")
      return route.fulfill({ json: { state: "ready_with_media", message: "Library ready." } });
    if (path === "/media/tree")
      return route.fulfill({
        json: { folders: [], items: [media, secondMedia], nextCursor: null },
      });
    if (path === `/media/${media.id}`) return route.fulfill({ json: media });
    if (path === `/media/${secondMedia.id}`) return route.fulfill({ json: secondMedia });
    if (path === "/destinations")
      return route.fulfill({
        json: {
          destinations: [
            { id: "download", label: "Browser download", kind: "download", retention: "24h" },
            { id: "archive", label: "Review archive", kind: "archive", retention: "durable" },
          ],
          capabilities: { saveBesideSource: false },
        },
      });
    if (path === "/projects" && request.method() === "GET")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/settings")
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
    if (path === "/batches" && request.method() === "GET")
      return route.fulfill({
        json: { items: [], nextCursor: null } satisfies EffectApiTypes.BatchPage,
      });
    if (path === `/batches/${batch.batchId}/events`) {
      const terminalJob: EffectApiTypes.Job = {
        ...job,
        state: "succeeded",
        revision: 2,
        progress: 1,
        result: {
          outputName: "camera.mkv",
          container: "mkv",
          sizeBytes: 100,
          retainUntil: "2099-01-01T00:00:00Z",
          destinationKind: "download",
          destinationId: "download",
        },
      };
      const terminalBatch: EffectApiTypes.Batch = {
        ...batch,
        state: "succeeded",
        progress: 1,
        jobs: [terminalJob],
      };
      return route.fulfill({
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
          "X-Request-ID": "r-create-clips-batch",
        },
        body: [
          `id: batch-${batch.batchId}-2`,
          "event: snapshot",
          `data: ${JSON.stringify(terminalBatch)}`,
          "",
          "",
        ].join("\n"),
      });
    }
    if (path.endsWith("/exports/preflight"))
      return route.fulfill({
        json: {
          allowed: true,
          selection: [],
          findings: [],
        } satisfies EffectApiTypes.ExportPreflight,
      });
    if (/^\/projects\/p_[A-Za-z0-9_-]{12,64}\/exports$/.test(path) && request.method() === "POST") {
      const body = request.postDataJSON() as EffectApiTypes.ExportSubmissionInput;
      expect(body.projectRevision).toBeGreaterThanOrEqual(1);
      expect(request.headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      batch = {
        ...batch,
        projectId: path.split("/")[2]!,
        projectRevision: body.projectRevision,
      };
      job = { ...job, projectId: batch.projectId!, projectRevision: body.projectRevision };
      return route.fulfill({
        status: 202,
        json: {
          batchId: batch.batchId,
          jobs: [job],
        } satisfies EffectApiTypes.BatchExportSubmission,
      });
    }
    if (/^\/projects\/p_[A-Za-z0-9_-]{12,64}$/.test(path) && request.method() === "PUT") {
      const body = request.postDataJSON();
      const revision = typeof body.revision === "number" ? body.revision + 1 : 1;
      return route.fulfill({
        json: {
          ...body,
          id: path.split("/").pop(),
          revision,
          schemaVersion: 2,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
    }
    return route.fallback();
  });
  await page.route(`${origin}/media/v2/**`, (route) =>
    new URL(route.request().url()).pathname.endsWith("/thumbnails")
      ? route.fulfill({
          status: 503,
          headers: { "X-Request-ID": "r-create-clips-thumbnail" },
          json: {
            error: {
              code: "internal_error",
              message: "Thumbnail unavailable.",
              requestId: "r-create-clips-thumbnail",
            },
          },
        })
      : route.fulfill({ json: { startMs: 0, durationMs: 10_000, peaks: [0.2, 0.8] } }),
  );
});

test("Create clips saves a dirty revision before fresh preflight and batch submission", async ({
  page,
}) => {
  const api = `${origin}/api/v2`;
  let projectId: string | undefined;
  const batchId = "b_0123456789ab";
  const jobId = "j_0123456789ab";
  let job: EffectApiTypes.Job = {
    id: jobId,
    batchId,
    type: "export",
    state: "queued",
    revision: 1,
    progress: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  let terminalJob: EffectApiTypes.Job = {
    ...job,
    state: "succeeded",
    revision: 2,
    progress: 1,
    result: {
      outputName: "camera.mkv",
      container: "mkv",
      sizeBytes: 100,
      retainUntil: "2099-01-01T00:00:00Z",
      destinationId: "download",
      destinationKind: "download",
    },
  };
  let startBatchStream!: () => void;
  let releaseStreams!: () => void;
  const batchStreamStarted = new Promise<void>((resolve) => (startBatchStream = resolve));
  const streamsReleased = new Promise<void>((resolve) => (releaseStreams = resolve));
  const calls: string[] = [];
  const deleteRequests: string[] = [];
  let batchListRequests = 0;
  let releaseStaleBatchList!: () => void;
  let markStaleBatchListStarted!: () => void;
  let markStaleBatchListCompleted!: () => void;
  const staleBatchListReleased = new Promise<void>((resolve) => (releaseStaleBatchList = resolve));
  const staleBatchListStarted = new Promise<void>(
    (resolve) => (markStaleBatchListStarted = resolve),
  );
  const staleBatchListCompleted = new Promise<void>(
    (resolve) => (markStaleBatchListCompleted = resolve),
  );
  let savedBody: Record<string, unknown> | undefined;
  let savedRevision: number | undefined;
  let submittedBody: EffectApiTypes.ExportSubmissionInput | undefined;
  let idempotencyKey: string | undefined;
  await page.route(`${api}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice("/api/v2".length);
    if (request.method() === "DELETE") {
      deleteRequests.push(path);
      return route.fulfill({ status: 204 });
    }
    if (path === "/media/status")
      return route.fulfill({ json: { state: "ready_with_media", message: "Library ready." } });
    if (path === "/media/tree")
      return route.fulfill({ json: { folders: [], items: [media], nextCursor: null } });
    if (path === `/media/${media.id}`) return route.fulfill({ json: media });
    if (path === "/projects" && request.method() === "GET")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/settings")
      return route.fulfill({
        json: {
          settings: {
            destinations: [{ id: "download", label: "Browser download", kind: "download" }],
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
          revision: 1,
          schemaVersion: 2,
          updatedAt: "2026-01-01T00:00:00Z",
          pathsConstrained: false,
          roots: {},
        },
      });
    if (path === "/destinations")
      return route.fulfill({
        json: {
          destinations: [{ id: "download", label: "Browser download", kind: "download" }],
          capabilities: { saveBesideSource: false },
        },
      });
    if (path === "/batches" && request.method() === "GET") {
      batchListRequests++;
      if (batchListRequests === 1) return route.fulfill({ json: { items: [], nextCursor: null } });
      markStaleBatchListStarted();
      await staleBatchListReleased;
      const response = await route.fulfill({
        json: {
          items: [
            {
              batchId,
              projectId: projectId!,
              projectRevision: 1,
              state: "queued",
              progress: 0,
              jobs: [job],
            },
          ],
          nextCursor: null,
        },
      });
      markStaleBatchListCompleted();
      return response;
    }
    const projectPath = path.match(/^\/projects\/(p_[A-Za-z0-9_-]{12,64})$/);
    if (projectPath && request.method() === "PUT") {
      projectId = projectPath[1];
      calls.push("save");
      savedBody = request.postDataJSON();
      savedRevision = 1;
      return route.fulfill({
        json: {
          ...savedBody,
          id: projectId,
          revision: savedRevision,
          schemaVersion: 2,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
    }
    if (
      /^\/projects\/p_[A-Za-z0-9_-]{12,64}\/exports\/preflight$/.test(path) &&
      request.method() === "POST"
    ) {
      calls.push("preflight");
      return route.fulfill({ json: { allowed: true, selection: [0], findings: [] } });
    }
    if (/^\/projects\/p_[A-Za-z0-9_-]{12,64}\/exports$/.test(path) && request.method() === "POST") {
      calls.push("export");
      submittedBody = request.postDataJSON() as EffectApiTypes.ExportSubmissionInput;
      idempotencyKey = request.headers()["idempotency-key"];
      job = { ...job, projectId: projectId!, projectRevision: savedRevision! };
      return route.fulfill({
        status: 202,
        headers: { "X-Request-ID": "r-create-clips-export" },
        json: { batchId, jobs: [job] } satisfies EffectApiTypes.BatchExportSubmission,
      });
    }
    if (path === `/batches/${batchId}/events`) {
      startBatchStream();
      await streamsReleased;
      const terminalBatch = {
        batchId,
        projectId: projectId!,
        projectRevision: savedRevision!,
        state: "succeeded",
        progress: 1,
        jobs: [terminalJob],
      };
      terminalJob = {
        ...terminalJob,
        projectId: projectId!,
        projectRevision: savedRevision!,
      };
      return route.fulfill({
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
          "X-Request-ID": "r-create-clips-primary-batch",
        },
        body: sseSnapshotFrame(`batch-${batchId}-2`, terminalBatch),
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: "not_found", message: "Not found", requestId: "test" } },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await addToProject(page);
  await addSegment(page);
  await openExport(page);
  const create = page.getByRole("button", { name: "Create clips" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByText("Export queued.", { exact: true })).toBeVisible();
  await Promise.all([staleBatchListStarted, batchStreamStarted]);
  await page.getByRole("button", { name: "Cancel export", exact: true }).click();
  await expect.poll(() => deleteRequests).toEqual([`/batches/${batchId}`]);
  await page.getByRole("button", { name: "Hide editing tools", exact: true }).click();
  releaseStreams();
  await expect(page.getByRole("button", { name: "Show editing tools", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show editing tools", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Current batch" }).getByText("succeeded", { exact: true }),
  ).toBeVisible();
  releaseStaleBatchList();
  await staleBatchListCompleted;
  await expect(page.locator(".queue-batch-heading .badge")).toHaveText("succeeded");
  expect(calls).toEqual(["save", "preflight", "export"]);
  expect(deleteRequests).toEqual([`/batches/${batchId}`]);
  expect(submittedBody).toMatchObject({ projectRevision: savedRevision });
  expect(idempotencyKey).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(savedBody?.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ exportOptions: expect.objectContaining({ mode: "separate" }) }),
    ]),
  );
});

test("batch container choice saves MOV for every selected item and matches the output plan", async ({
  page,
}) => {
  const savedBodies: unknown[] = [];
  const preflightBodies: unknown[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "PUT" && /^\/api\/v2\/projects\/[^/]+$/.test(path))
      savedBodies.push(request.postDataJSON());
    if (path.endsWith("/exports/preflight")) preflightBodies.push(request.postDataJSON());
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
  await page.getByLabel("Output container", { exact: true }).selectOption("mp4");
  await expect(page.getByLabel("Output container", { exact: true })).toHaveValue("mp4");
  await expect
    .poll(() => savedBodies.at(-1))
    .toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            mediaId: media.id,
            exportOptions: expect.objectContaining({ container: "mkv" }),
          }),
          expect.objectContaining({
            mediaId: secondMedia.id,
            exportOptions: expect.objectContaining({ container: "mp4" }),
          }),
        ],
      }),
    );
  await page.getByLabel("Output container", { exact: true }).selectOption("mov");
  await page.getByRole("radio", { name: "Selected project items" }).check();
  await page.getByRole("button", { name: "Select all" }).click();

  const plan = page.locator('[aria-label="Export plan"]');
  await expect(plan).toContainText("2 clips · MOV");
  await expect(plan.getByText("camera-Segment 001.mov")).toBeVisible();
  await expect(plan.getByText("second-Segment 001.mov")).toBeVisible();
  await page.getByRole("button", { name: "Create clips" }).click();
  await expect(
    page.getByRole("region", { name: "Current batch" }).getByText("succeeded", { exact: true }),
  ).toBeVisible();

  expect(savedBodies.at(-1)).toEqual(
    expect.objectContaining({
      items: [
        expect.objectContaining({
          mediaId: media.id,
          exportOptions: expect.objectContaining({ container: "mov" }),
        }),
        expect.objectContaining({
          mediaId: secondMedia.id,
          exportOptions: expect.objectContaining({ container: "mov" }),
        }),
      ],
    }),
  );
  const preflightBody = preflightBodies.at(-1);
  if (!preflightBody || typeof preflightBody !== "object" || !("itemIds" in preflightBody))
    throw new Error("Preflight request did not include selected project items.");
  expect(preflightBody).toEqual(expect.objectContaining({ container: "mov" }));
  expect(preflightBody.itemIds).toHaveLength(2);
});

test("multi-item preflight checks every selected item before submission", async ({ page }) => {
  const calls: string[] = [];
  const preflightItems: string[][] = [];
  let exports = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "PUT" && /^\/api\/v2\/projects\/[^/]+$/.test(path)) {
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
  await page.route(`${origin}/api/v2/projects/*/exports/preflight`, (route) =>
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
  const workflowCalls: string[] = [];
  await page.route(`${origin}/api/v2/projects/*`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saves += 1;
    if (saves === 1)
      return route.fulfill({
        status: 500,
        headers: { "X-Request-ID": "r-save-error" },
        json: {
          error: {
            code: "internal_error",
            message: "Internal server error.",
            requestId: "r-save-error",
          },
        },
      });
    const body = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ...body,
        id: "p_retry-create01",
        revision: 1,
        schemaVersion: 2,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "PUT" && /^\/api\/v2\/projects\/[^/]+$/.test(path))
      workflowCalls.push("save");
    else if (path.endsWith("/exports/preflight")) workflowCalls.push("preflight");
    else if (path.endsWith("/exports")) {
      workflowCalls.push("export");
      exports += 1;
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await addToProject(page);
  await addSegment(page);
  await openExport(page);
  const create = page.getByRole("button", { name: "Create clips" });
  workflowCalls.length = 0;
  await create.click();
  await expect(
    page
      .getByRole("region", { name: "Export" })
      .getByText("Project save failed. Retry when ready."),
  ).toBeVisible();
  expect(workflowCalls).toEqual(["save"]);
  expect(exports).toBe(0);
  await expect(page.getByRole("status", { name: "Project status" })).toHaveText("Save failed");
  await expect(page.getByText("Internal server error.", { exact: true })).toHaveCount(0);
  await expect(create).toBeEnabled();
  await create.click();
  await expect(
    page.getByRole("region", { name: "Current batch" }).getByText("succeeded", { exact: true }),
  ).toBeVisible();
  expect(saves).toBe(2);
  expect(exports).toBe(1);
  expect(workflowCalls).toEqual(["save", "save", "preflight", "export"]);
});

test("conflicted saves never submit preflight or export", async ({ page }) => {
  const calls: string[] = [];
  await page.route(`${origin}/api/v2/projects/*`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    calls.push("save");
    return route.fulfill({
      status: 409,
      headers: { "X-Request-ID": "r-conflict" },
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
  await page.route(`${origin}/api/v2/projects/*/exports/preflight`, async (route) => {
    const body = route.request().postDataJSON() as { itemIds?: string[] };
    const itemIds = body.itemIds ?? [];
    preflightItems.push(itemIds);
    if (itemIds.length < 2)
      return route.fulfill({
        json: {
          allowed: true,
          selection: [],
          findings: [],
        } satisfies EffectApiTypes.ExportPreflight,
      });
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
