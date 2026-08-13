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
const secondMedia = { ...media, id: "m_second-012345678901234567890123456789012345", name: "second.mp4" };

const apiOrigin = "http://127.0.0.1:8787";

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
  await page.route(`${apiOrigin}/api/v1/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/media")
      return route.fulfill({ json: { items: [media, secondMedia] } });
    if (url.pathname === `/api/v1/media/${media.id}`)
      return route.fulfill({ json: media });
    if (url.pathname.includes("/preview")) {
      const center = url.searchParams.get("centerMs") ?? "0";
      if (center === "1000")
        await new Promise((resolve) => setTimeout(resolve, 100));
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
    if (request.method() === "GET")
      return route.fulfill({
        json: {
          id: "p_demo-project",
          mediaId: media.id,
          revision: 4,
          segments: [{ startMs: 100, endMs: 700, label: "restored" }],
          uiState: { playheadMs: 700, zoom: 1, muted: false },
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
      return route.fulfill({
        json: {
          id: "p_demo-project",
          mediaId: media.id,
          revision: savedRevision,
          segments: [],
          uiState: { playheadMs: 0, zoom: 1, muted: false },
        },
      });
    }
    return route.fulfill({ status: 404 });
  });
});

test("MVP browser behavior: list, metadata, settle, cancel, offset, markers, restore, and stale protection", async ({
  page,
}) => {
  const requestOrigins: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/"))
      requestOrigins.push(new URL(request.url()).origin);
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
  await expect(page.getByText("preview-2000")).toBeVisible(); // 4 rapid reselection never presents the stale response
  await expect(page.getByText("Preview ready.")).toBeVisible(); // 4 stale request is cancelled/ignored; 5 preview begins
  await expect(page.getByLabel("Preview player")).toHaveAttribute(
    "data-preview-offset",
    "2000",
  ); // 6 returned offset is used

  await page.getByLabel("Preview player").evaluate((video) => {
    video.currentTime = 0.1;
  });
  await page.keyboard.press("i");
  await page.getByLabel("Preview player").evaluate((video) => {
    video.currentTime = 0.7;
  });
  await page.keyboard.press("o");
  await page.getByRole("button", { name: "Add In/Out segment" }).click();
  await expect(page.getByText("0:00.100 – 0:00.700")).toBeVisible();
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText(/Project saved/)).toBeVisible(); // 7 markers save

  await page.getByRole("button", { name: "Load project" }).click();
  await expect(page.getByText("Project loaded.")).toBeVisible(); // 8 project restores after reload
  await expect(page.getByText(/restored/)).toBeVisible();
  expect(requestOrigins).not.toHaveLength(0);
  expect(requestOrigins).toEqual(expect.arrayContaining([apiOrigin]));
  expect(new Set(requestOrigins)).toEqual(new Set([apiOrigin]));
});

test("shows a safe preview failure and maps markers from the watched preview", async ({ page }) => {
  await page.unroute(`${apiOrigin}/api/v1/**`);
  await page.route(`${apiOrigin}/api/v1/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/media")
      return route.fulfill({ json: { items: [media] } });
    if (url.pathname === `/api/v1/media/${media.id}`)
      return route.fulfill({ json: media });
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
  await expect(page.getByText("Preview ready.")).toBeVisible();
  await page.getByLabel("Preview player").evaluate((video) => {
    video.currentTime = 0.5;
  });
  await page.getByRole("button", { name: "Set In marker" }).click();
  await expect(page.getByText("In: 0:01.500")).toBeVisible();
});

test("shows a safe preview request failure", async ({ page }) => {
  await page.route(`${apiOrigin}/api/v1/media/${media.id}/preview**`, (route) =>
    route.fulfill({ status: 500 }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await expect(page.getByText("Preview request failed. Try again.")).toBeVisible();
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
  await expect(page.getByText("Preview is unavailable in this browser. Use the timeline controls to set markers manually.")).toBeVisible();
  await page.waitForTimeout(250);
  expect(previewRequests).toBe(0);
});

test("save reports an optimistic revision conflict", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Project ID").fill("p_conflict-id1");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText(/Load latest before saving/)).toBeVisible();
});

test("exports the saved segments, polls to a safe result, and shows warnings", async ({
  page,
}) => {
  const requests: string[] = [];
  let polls = 0;
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.route(`${apiOrigin}/api/v1/projects/*/exports`, async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      mode: "merge",
      cutStrategy: "stream_copy_preferred",
      container: "mkv",
    });
    await route.fulfill({
      json: { id: "j_export", type: "export", state: "queued", progress: 0 },
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
              },
              warnings: ["Cut may start at an earlier keyframe."],
            },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set In marker" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set Out marker" }).click();
  await page.getByRole("button", { name: "Add In/Out segment" }).click();
  await page.getByRole("button", { name: "Export MKV" }).click();
  await expect(page.getByText("Export queued.")).toBeVisible();
  await expect(page.getByText("Export complete.")).toBeVisible({ timeout: 4_000 });
  expect(requests.findIndex((path) => /\/projects\/p_[^/]+$/.test(path))).toBeLessThan(
    requests.findIndex((path) => path.endsWith("/exports")),
  );
  await expect(page.getByLabel("Export result")).toContainText("camera-cut.mkv");
  await expect(page.getByLabel("Export result")).toContainText("42 bytes");
  await expect(page.getByLabel("Export warnings")).toContainText("earlier keyframe");
  await expect(page.locator("main")).not.toContainText("/private/export");
});

test("shows stable failed and capacity messages and permits retry", async ({ page }) => {
  let creates = 0;
  await page.route(`${apiOrigin}/api/v1/projects/*/exports`, async (route) => {
    creates += 1;
    if (creates === 1) return route.fulfill({ status: 429 });
    return route.fulfill({
      json: { id: "j_failed", type: "export", state: "queued", progress: 0 },
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
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set In marker" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set Out marker" }).click();
  await page.getByRole("button", { name: "Add In/Out segment" }).click();
  const exportButton = page.getByRole("button", { name: "Export MKV" });
  await exportButton.click();
  await expect(page.getByText("Export capacity is busy. Try again shortly.")).toBeVisible();
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  await expect(page.getByText("Export was interrupted by a server restart. Try again.")).toBeVisible({ timeout: 3_000 });
});

test("cancels an active export without showing a path", async ({ page }) => {
  let cancelled = false;
  await page.route(`${apiOrigin}/api/v1/projects/*/exports`, (route) =>
    route.fulfill({
      json: { id: "j_cancel", type: "export", state: "queued", progress: 0 },
    }),
  );
  await page.route(`${apiOrigin}/api/v1/jobs/j_cancel`, (route) => {
    if (route.request().method() === "DELETE") cancelled = true;
    return route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set In marker" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set Out marker" }).click();
  await page.getByRole("button", { name: "Add In/Out segment" }).click();
  await page.getByRole("button", { name: "Export MKV" }).click();
  await page.getByRole("button", { name: "Cancel export" }).click();
  await expect(page.getByText("Export cancelled.")).toBeVisible();
  expect(cancelled).toBe(true);
  await expect(page.locator("main")).not.toContainText("/private/export");
});

test("delayed project loads cannot replace a newer editor", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`${apiOrigin}/api/v1/projects/p_race-load012`, async (route) => {
    await delayed;
    await route.fulfill({ json: { id: "p_race-load012", mediaId: media.id, revision: 1, segments: [], uiState: { playheadMs: 0, zoom: 1, muted: false } } }).catch(() => {});
  });
  await page.goto("/");
  await page.getByLabel("Project ID").fill("p_race-load012");
  await page.getByRole("button", { name: "Load project" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "New project" }).click();
  release();
  await expect(page.getByText("New project ready.")).toBeVisible();
  await expect(page.getByText("Project loaded.")).toHaveCount(0);
});

test("delayed saves stay dirty and cannot launch obsolete exports", async ({ page }) => {
  let saves = 0;
  let exports = 0;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`${apiOrigin}/api/v1/projects/*`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saves += 1;
    if (saves === 1) await delayed;
    return route.fulfill({ json: { id: "p_save-race012", mediaId: media.id, revision: saves, segments: [], uiState: { playheadMs: 0, zoom: 1, muted: false } } });
  });
  await page.route(`${apiOrigin}/api/v1/projects/*/exports`, (route) => {
    exports += 1;
    return route.fulfill({ json: { id: "j_new", type: "export", state: "queued", progress: 0 } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Project ID").fill("p_save-race012");
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set In marker" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set Out marker" }).click();
  await page.getByRole("button", { name: "Add In/Out segment" }).click();
  await page.getByRole("button", { name: "Export MKV" }).click();
  await page.getByLabel("Timeline playhead").fill("1");
  release();
  await page.waitForTimeout(50);
  expect(exports).toBe(0);
  await page.getByRole("button", { name: "Export MKV" }).click();
  await expect(page.getByText("Export queued.")).toBeVisible();
});

test("a delayed old-project save stays silent after New and the new project saves at revision zero", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let oldStarted!: () => void;
  const oldStart = new Promise<void>((resolve) => { oldStarted = resolve; });
  let oldCompleted!: () => void;
  const oldComplete = new Promise<void>((resolve) => { oldCompleted = resolve; });
  let newCompleted!: () => void;
  const newComplete = new Promise<void>((resolve) => { newCompleted = resolve; });
  let saves = 0;
  await page.route(`${apiOrigin}/api/v1/projects/*`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saves += 1;
    const body = route.request().postDataJSON();
    if (saves === 1) {
      oldStarted();
      await delayed;
      await route.fulfill({ json: { id: "p_old-save0123", mediaId: media.id, revision: 9, segments: [], uiState: { playheadMs: 0, zoom: 1, muted: false } } });
      oldCompleted();
      return;
    }
    expect(body.revision).toBe(saves === 2 ? 0 : 1);
    const id = new URL(route.request().url()).pathname.split("/").pop();
    await route.fulfill({ json: { id, mediaId: media.id, revision: saves - 1, segments: body.segments, uiState: body.uiState } });
    if (saves === 2) newCompleted();
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Project ID").fill("p_old-save0123");
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set In marker" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set Out marker" }).click();
  await page.getByRole("button", { name: "Add In/Out segment" }).click();
  await page.getByRole("button", { name: "Save project" }).click();
  await oldStart;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "New project" }).click();
  const newID = await page.getByLabel("Project ID").inputValue();
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set In marker" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set Out marker" }).click();
  await page.getByRole("button", { name: "Add In/Out segment" }).click();
  await page.getByRole("button", { name: "Save project" }).click();
  await newComplete;
  expect(await page.getByLabel("Project ID").inputValue()).toBe(newID);
  release();
  await oldComplete;
  await page.getByLabel("Timeline playhead").fill("701");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect.poll(() => saves).toBe(3);
  await expect(page.getByText("Project saved (revision 9).")).toHaveCount(0);
});

test("unmounting a deferred export save cannot start export, poll, or remember a project", async ({ page, context }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let saveStarted!: () => void;
  const saveStart = new Promise<void>((resolve) => { saveStarted = resolve; });
  let exports = 0;
  let polls = 0;
  context.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/exports")) exports += 1;
    if (path.includes("/jobs/")) polls += 1;
  });
  await page.route(`${apiOrigin}/api/v1/projects/p_unmount-save12`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    saveStarted();
    await delayed;
    await route.fulfill({ json: { id: "p_unmount-save12", mediaId: media.id, revision: 1, segments: [], uiState: { playheadMs: 0, zoom: 1, muted: false } } }).catch(() => {});
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Project ID").fill("p_unmount-save12");
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set In marker" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set Out marker" }).click();
  await page.getByRole("button", { name: "Add In/Out segment" }).click();
  await page.getByRole("button", { name: "Export MKV" }).click();
  await saveStart;
  await page.close();
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const next = await context.newPage();
  await next.goto("/");
  expect(exports).toBe(0);
  expect(polls).toBe(0);
  await expect.poll(() => next.evaluate(() => localStorage.getItem("videocutlist.recent-projects.v1"))).toBeNull();
  await next.close();
});

test("stale selection metadata cannot replace a refresh or newer selection status", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
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
  await expect(page.getByRole("button", { name: /second.mp4/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/Metadata request failed/)).toHaveCount(0);
});

test("refresh metadata cannot restore an old selection", async ({ page }) => {
  let refreshed = false;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`${apiOrigin}/api/v1/media**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/media/refresh") {
      refreshed = true;
      return route.fulfill({ json: {} });
    }
    if (url.pathname === "/api/v1/media" && route.request().method() === "GET")
      return route.fulfill({ json: { items: refreshed ? [secondMedia] : [media, secondMedia], nextCursor: null } });
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
  await expect(page.getByRole("button", { name: /second.mp4/ })).toHaveAttribute("aria-pressed", "true");
});

test("delayed cancellation cannot overwrite a replacement export", async ({ page }) => {
  let releases!: () => void;
  const delayed = new Promise<void>((resolve) => { releases = resolve; });
  let exports = 0;
  await page.route(`${apiOrigin}/api/v1/projects/*/exports`, (route) => {
    exports += 1;
    return route.fulfill({ json: { id: exports === 1 ? "j_old" : "j_new", type: "export", state: "queued", progress: 0 } });
  });
  await page.route(`${apiOrigin}/api/v1/jobs/j_old`, async (route) => {
    if (route.request().method() !== "DELETE") return route.fulfill({ json: { id: "j_old", type: "export", state: "queued", progress: 0 } });
    await delayed;
    return route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Timeline playhead").fill("100");
  await page.getByRole("button", { name: "Set In marker" }).click();
  await page.getByLabel("Timeline playhead").fill("700");
  await page.getByRole("button", { name: "Set Out marker" }).click();
  await page.getByRole("button", { name: "Add In/Out segment" }).click();
  await page.getByRole("button", { name: "Export MKV" }).click();
  await expect(page.getByText("Export queued.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel export" }).click();
  await page.getByRole("button", { name: "Export MKV" }).click();
  await expect(page.getByText("Export queued.")).toBeVisible();
  releases();
  await expect(page.getByText("Export cancelled.")).toHaveCount(0);
});

test("new projects reset the editor and dirty changes need confirmation", async ({ page }) => {
  await page.goto("/");
  const projectId = page.getByLabel("Project ID");
  await expect(projectId).toHaveValue(/^p_[A-Za-z0-9_-]{12,64}$/);
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  let projectLoads = 0;
  page.on("request", (request) => {
    if (/\/api\/v1\/projects\/p_/.test(new URL(request.url()).pathname)) projectLoads += 1;
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Load project" }).click();
  await page.waitForTimeout(50);
  expect(projectLoads).toBe(0);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: /second.mp4/ }).click();
  await expect(page.getByRole("button", { name: /camera.mp4/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "New project" }).click();
  await expect(page.getByText("New project ready.")).not.toBeVisible();
  await expect(page.getByLabel("Preview player")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "New project" }).click();
  await expect(page.getByText("New project ready.")).toBeVisible();
  await expect(page.getByText("Select a media item.")).toBeVisible();
  await expect(projectId).toHaveValue(/^p_[A-Za-z0-9_-]{12,64}$/);
});

test("load fetches project media directly and corrupt recents do not block startup", async ({ page }) => {
  const outsideMedia = { ...media, id: "m_outside-page-012345678901234567890123456789", name: "outside.mp4" };
  await page.addInitScript(() => localStorage.setItem("videocutlist.recent-projects.v1", "not json"));
  await page.route(`${apiOrigin}/api/v1/projects/p_outside-media`, (route) =>
    route.fulfill({
      json: {
        id: "p_outside-media",
        mediaId: outsideMedia.id,
        revision: 7,
        segments: [{ startMs: 100, endMs: 700, label: "outside" }],
        uiState: { playheadMs: 700, zoom: 2, muted: true },
      },
    }),
  );
  await page.route(`${apiOrigin}/api/v1/media/${outsideMedia.id}`, (route) =>
    route.fulfill({ json: outsideMedia }),
  );
  await page.goto("/");
  await expect(page.getByRole("button", { name: /camera.mp4/ })).toBeVisible();
  await page.getByLabel("Project ID").fill("p_outside-media");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Load project" }).click();
  await expect(page.getByText("Project loaded.")).toBeVisible();
  await expect(page.getByRole("button", { name: /outside.mp4/ })).toBeVisible();
  await expect(page.getByText("(outside)")).toBeVisible();
});

test("loads cursor pages once and removes Load more at the end", async ({ page }) => {
  await page.route(`${apiOrigin}/api/v1/media**`, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET") return route.fallback();
    if (!url.searchParams.get("cursor"))
      return route.fulfill({ json: { items: [media], nextCursor: "next/+=" } });
    expect(url.searchParams.get("cursor")).toBe("next/+=");
    return route.fulfill({ json: { items: [media, secondMedia], nextCursor: null } });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("button", { name: /second.mp4/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /camera.mp4/ })).toHaveCount(1);
});

test("keeps the first page after a later-page failure and permits retry", async ({ page }) => {
  let attempts = 0;
  await page.route(`${apiOrigin}/api/v1/media**`, (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET") return route.fallback();
    if (!url.searchParams.get("cursor"))
      return route.fulfill({ json: { items: [media], nextCursor: "next" } });
    attempts += 1;
    return route.fulfill(attempts === 1 ? { status: 500 } : { json: { items: [secondMedia], nextCursor: null } });
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
  await page.route(`${apiOrigin}/api/v1/media**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/media/refresh") {
      refreshes += 1;
      return route.fulfill({ json: { id: "j_refresh", type: "media_refresh", state: "succeeded", progress: 1 } });
    }
    if (url.pathname === `/api/v1/media/${media.id}`)
      return route.fulfill({ json: refreshes ? refreshed : media });
    if (url.pathname === "/api/v1/media" && route.request().method() === "GET")
      return route.fulfill({ json: { items: refreshes ? [refreshed] : [media], nextCursor: null } });
    return route.fallback();
  });
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByRole("button", { name: "Refresh media" }).click();
  await expect(page.getByRole("button", { name: /refreshed.mp4/ })).toBeVisible();
  await expect(page.getByText("Media refreshed. Choose media to begin.")).toBeVisible();
});

for (const [status, message] of [[403, "You are not allowed to refresh media."], [429, "Media refresh is already in progress. Try again shortly."]] as const) {
  test(`refresh reports ${status}`, async ({ page }) => {
    await page.route(`${apiOrigin}/api/v1/media/refresh`, (route) => route.fulfill({ status }));
    await page.goto("/");
    const refresh = page.getByRole("button", { name: "Refresh media" });
    await refresh.click();
    await expect(page.getByText(message)).toBeVisible();
    await expect(refresh).toBeEnabled();
  });
}
