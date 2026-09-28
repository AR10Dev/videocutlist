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

async function openProjectTools(page: import("@playwright/test").Page) {
  const mediaToggle = page.getByRole("button", { name: /media library/ }).first();
  if ((await mediaToggle.getAttribute("aria-expanded")) === "false") await mediaToggle.click();
  await page.locator(".project-menu > summary").click();
  await page.getByRole("button", { name: "Project tools", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Project tools", exact: true })).toBeVisible();
}

test("project tools is a native modal and returns focus on Escape", async ({ page }) => {
  await page.goto("/");
  const trigger = page.locator(".project-menu > summary");
  await openProjectTools(page);
  const dialog = page.getByRole("dialog", { name: "Project tools" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveJSProperty("open", true);
  expect(await dialog.evaluate((element) => element.matches(":modal"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("export cancellation is isolated from a changed media context", async ({ page }) => {
  const secondMedia = {
    ...media,
    id: "m_0123456789012345678901234567890123456789013",
    name: "second.mp4",
  };
  let deleteStarted!: () => void;
  const deleteSeen = new Promise<void>((resolve) => (deleteStarted = resolve));
  let releaseDelete!: () => void;
  const deleteResponse = new Promise<void>((resolve) => (releaseDelete = resolve));
  let deleteAborted = false;
  let cancellationRequested = false;
  const queuedJob = {
    id: "job_test",
    batchId: "b_test",
    projectItemId: "i_test",
    mediaLabel: "camera.mp4",
    type: "export",
    state: "queued",
    progress: 0,
  };
  const cancelledJob = { ...queuedJob, state: "cancelled", progress: 1 };
  const queuedBatch = {
    batchId: "b_test",
    projectId: "p_test",
    projectRevision: 1,
    state: "queued",
    progress: 0,
    jobs: [queuedJob],
  };
  const cancelledBatch = {
    ...queuedBatch,
    state: "cancelled",
    progress: 1,
    jobs: [cancelledJob],
  };
  let releaseOldMetadata!: () => void;
  const oldMetadata = new Promise<void>((resolve) => (releaseOldMetadata = resolve));
  page.on("requestfailed", (request) => {
    if (request.method() === "DELETE" && request.url().endsWith("/api/v1/batches/b_test"))
      deleteAborted = true;
  });

  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/media" || url.pathname === "/api/v1/media/tree")
      return route.fulfill({ json: { folders: [], items: [media, secondMedia] } });
    if (url.pathname === `/api/v1/media/${media.id}`) {
      await oldMetadata;
      return route.fulfill({ json: media });
    }
    if (url.pathname === `/api/v1/media/${secondMedia.id}`)
      return route.fulfill({ json: secondMedia });
    if (url.pathname === "/api/v1/media/status")
      return route.fulfill({ json: { state: "ready_with_media", message: "Ready" } });
    if (url.pathname === "/api/v1/destinations")
      return route.fulfill({
        json: { destinations: [{ id: "download", label: "Downloads", kind: "download" }] },
      });
    if (url.pathname === "/api/v1/batches") return route.fulfill({ json: { items: [] } });
    if (url.pathname === "/api/v1/batches/b_test" && request.method() === "GET")
      return route.fulfill({ json: cancellationRequested ? cancelledBatch : queuedBatch });
    if (url.pathname === "/api/v1/jobs/job_test" && request.method() === "GET")
      return route.fulfill({ json: cancellationRequested ? cancelledJob : queuedJob });
    if (request.method() === "PUT" && url.pathname.startsWith("/api/v1/projects/"))
      return route.fulfill({
        json: {
          id: "p_test",
          mediaId: media.id,
          revision: 1,
          segments: [{ startMs: 0, endMs: 1000 }],
          uiState: { playheadMs: 0, zoom: 1, muted: false },
        },
      });
    if (request.method() === "POST" && url.pathname.endsWith("/preflight"))
      return route.fulfill({ json: { allowed: true, selection: [0], findings: [] } });
    if (request.method() === "POST" && url.pathname.endsWith("/exports"))
      return route.fulfill({
        json: {
          batchId: "b_test",
          jobs: [{ id: "job_test", type: "export", state: "queued", progress: 0 }],
        },
      });
    if (request.method() === "DELETE" && url.pathname === "/api/v1/batches/b_test") {
      cancellationRequested = true;
      deleteStarted();
      try {
        await deleteResponse;
        return route.fulfill({ status: 204 });
      } catch {
        deleteAborted = true;
        throw new Error("request aborted");
      }
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByRole("button", { name: "Add to project" }).click();
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("500");
  await page.getByRole("button", { name: "Set out" }).click();
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Select cut 1" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Save project from project header", exact: true }).click();
  await expect(page.getByRole("status", { name: "Project status" })).toHaveText("Saved");
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create clips" })).toBeEnabled();
  await page.getByRole("button", { name: "Create clips" }).click();
  await expect(page.getByRole("button", { name: "Cancel export" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel export" }).click();
  await deleteSeen;
  await page.getByRole("button", { name: /second.mp4/ }).click();
  await page.getByRole("button", { name: "Add to project" }).click();
  releaseDelete();
  await expect.poll(() => deleteAborted).toBe(true);
  releaseOldMetadata();
  await expect(page.getByLabel("Selected media")).toContainText("second.mp4");
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(page.getByText("Export cancelled.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel export" })).not.toBeVisible();
});

test("project tools expose naming and cut-list import before media selection", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a video to begin" })).toBeVisible();
  await openProjectTools(page);
  await expect(page.getByLabel("Project name")).toHaveValue("Untitled project");
  await page.getByText("Interchange", { exact: true }).click();
  await expect(page.getByLabel("Import cut list", { exact: true })).toBeVisible();
});

test("project interchange stays available in the compact sidebar after media is added", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
  });
  await page.route("http://127.0.0.1:8787/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/media" || url.pathname === "/api/v1/media/tree")
      return route.fulfill({ json: { folders: [], items: [media] } });
    if (url.pathname === `/api/v1/media/${media.id}`) return route.fulfill({ json: media });
    if (url.pathname === "/api/v1/media/status")
      return route.fulfill({ json: { state: "ready_empty", message: "Ready" } });
    if (route.request().method() === "PUT")
      return route.fulfill({ json: { id: "p_saved", revision: 1 } });
    return route.fulfill({ status: 404 });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByRole("button", { name: "Add to project" }).click();
  await openProjectTools(page);
  await page.getByText("Interchange", { exact: true }).click();
  await expect(page.getByLabel("Import cut list", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close project tools", exact: true }).click();
  await page.getByRole("button", { name: "Save project from project header", exact: true }).click();
  await expect(page.getByRole("status", { name: "Project status" })).toHaveText("Saved");
});

test("separates media selection from cut-list imports", async ({ page }) => {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
  });
  await page.route("http://127.0.0.1:8787/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/media" || url.pathname === "/api/v1/media/tree")
      return route.fulfill({ json: { folders: [], items: [media] } });
    if (url.pathname === `/api/v1/media/${media.id}`) return route.fulfill({ json: media });
    if (url.pathname === "/api/v1/media/status")
      return route.fulfill({ json: { state: "ready_empty", message: "Ready" } });
    if (route.request().method() === "PUT") return route.fulfill({ json: { revision: 1 } });
    return route.fulfill({ status: 404 });
  });

  await page.goto("/");
  await expect(page.getByLabel("Import cut list")).toHaveCount(0);

  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByRole("button", { name: "Add to project" }).click();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await openProjectTools(page);
  await page.getByText("Interchange", { exact: true }).click();
  await expect(page.getByLabel("Import cut list", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close project tools", exact: true }).click();
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Export", exact: true })).toBeVisible();
  await expect(page.getByLabel("Import cut list")).toHaveCount(0);
});
