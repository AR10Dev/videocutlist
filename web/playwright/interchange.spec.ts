import { expect, test } from "@playwright/test";
import { sseSnapshotFrame } from "./fixtures";

const origin = "http://127.0.0.1:8787";
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

async function installProjectApi(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
  });
  await page.route(`${origin}/api/v2/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v2/media/tree")
      return route.fulfill({ json: { folders: [], items: [media], nextCursor: null } });
    if (url.pathname === `/api/v2/media/${media.id}`) return route.fulfill({ json: media });
    if (url.pathname === "/api/v2/media/status")
      return route.fulfill({ json: { state: "ready_with_media", message: "Ready" } });
    if (url.pathname === "/api/v2/settings") return route.fulfill({ json: {} });
    if (url.pathname === "/api/v2/destinations")
      return route.fulfill({
        json: { destinations: [], capabilities: { saveBesideSource: false } },
      });
    if (url.pathname === "/api/v2/batches")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (request.method() === "GET" && url.pathname === "/api/v2/projects")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (request.method() === "PUT" && /^\/api\/v2\/projects\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").at(-1)!;
      const body = request.postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        json: {
          ...body,
          id,
          revision: Number(body.revision) + 1,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: "not_found", message: "Missing", requestId: "browser" } },
    });
  });
}

test("export cancellation remains effective when the active project item changes", async ({
  page,
}) => {
  const secondMedia = {
    ...media,
    id: "m_0123456789012345678901234567890123456789013",
    name: "second.mp4",
  };
  const batchId = "b_testbatch0001";
  const job = {
    id: "j_testjob00001",
    batchId,
    projectItemId: "i_testitem00001",
    mediaLabel: media.name,
    type: "export",
    state: "queued",
    revision: 1,
    progress: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  let cancellationRequested = false;
  let deleteStarted!: () => void;
  const deleteSeen = new Promise<void>((resolve) => (deleteStarted = resolve));
  let releaseDelete!: () => void;
  const deleteResponse = new Promise<void>((resolve) => (releaseDelete = resolve));
  let deleteCompleted = false;
  let projectId = "";
  let projectItemId = "";
  let destinationRequests = 0;
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
  });
  await page.route(`${origin}/api/v2/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "DELETE" && url.pathname === `/api/v2/batches/${batchId}`) {
      cancellationRequested = true;
      deleteStarted();
      try {
        await deleteResponse;
        deleteCompleted = true;
        return route.fulfill({ status: 204 });
      } catch {
        throw new Error("request aborted");
      }
    }
    if (url.pathname === "/api/v2/media/tree")
      return route.fulfill({
        json: { folders: [], items: [media, secondMedia], nextCursor: null },
      });
    if (url.pathname === `/api/v2/media/${media.id}`) return route.fulfill({ json: media });
    if (url.pathname === `/api/v2/media/${secondMedia.id}`)
      return route.fulfill({ json: secondMedia });
    if (url.pathname === "/api/v2/media/status")
      return route.fulfill({ json: { state: "ready_with_media", message: "Ready" } });
    if (url.pathname === "/api/v2/settings") return route.fulfill({ json: {} });
    if (url.pathname === "/api/v2/destinations") {
      destinationRequests++;
      if (destinationRequests === 1)
        return route.fulfill({
          status: 500,
          json: {
            error: {
              code: "internal_error",
              message: "Destination lookup is unavailable.",
              requestId: "r-destinations",
            },
          },
        });
      return route.fulfill({
        json: {
          destinations: [{ id: "download", label: "Downloads", kind: "download" }],
          capabilities: { saveBesideSource: false },
        },
      });
    }
    if (url.pathname === "/api/v2/batches")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (request.method() === "PUT" && /^\/api\/v2\/projects\/p_[^/]+$/.test(url.pathname)) {
      projectId = url.pathname.split("/").at(-1)!;
      const body = request.postDataJSON() as Record<string, unknown>;
      projectItemId = (body.items as Array<{ id: string }>)[0]!.id;
      return route.fulfill({
        json: {
          ...body,
          id: url.pathname.split("/").at(-1),
          revision: 1,
          schemaVersion: 2,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
    }
    if (request.method() === "POST" && url.pathname.endsWith("/exports/preflight"))
      return route.fulfill({ json: { allowed: true, selection: [0], findings: [] } });
    if (request.method() === "POST" && url.pathname.endsWith("/exports")) {
      job.projectItemId = projectItemId;
      return route.fulfill({ status: 202, json: { batchId, jobs: [job] } });
    }
    if (url.pathname === `/api/v2/batches/${batchId}/events`)
      return route.fulfill({
        headers: { "Content-Type": "text/event-stream" },
        body: sseSnapshotFrame("batch-cursor-1", {
          batchId,
          projectId,
          projectRevision: 1,
          state: cancellationRequested ? "cancelled" : "queued",
          progress: cancellationRequested ? 1 : 0,
          jobs: [
            cancellationRequested ? { ...job, state: "cancelled", revision: 2, progress: 1 } : job,
          ],
        }),
      });
    return route.fulfill({
      status: 404,
      json: { error: { code: "not_found", message: "Missing", requestId: "browser" } },
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /camera\.mp4/ }).click();
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
  await expect(page.getByRole("alert")).toContainText("Destination lookup is unavailable.");
  await expect(page.getByRole("button", { name: "Create clips" })).toBeDisabled();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create clips" })).toBeEnabled();
  await page.getByRole("button", { name: "Create clips" }).click();
  await expect(page.getByRole("button", { name: "Cancel export" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel export" }).click();
  await deleteSeen;
  await page.getByRole("button", { name: /second\.mp4/ }).click();
  await page.getByRole("button", { name: "Add to project" }).click();
  releaseDelete();
  await expect.poll(() => deleteCompleted).toBe(true);
  await expect(page.getByLabel("Selected media")).toContainText("second.mp4");
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Current batch" }).getByText("cancelled", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel export" })).not.toBeVisible();
});

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

test("project tools expose cut-list import before and after media selection", async ({ page }) => {
  await installProjectApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a video to begin" })).toBeVisible();
  await openProjectTools(page);
  await expect(page.getByLabel("Project name")).toHaveValue("Untitled project");
  await page.getByText("Interchange", { exact: true }).click();
  await expect(page.getByLabel("Import cut list", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close project tools", exact: true }).click();

  await page.getByRole("button", { name: /camera\.mp4/ }).click();
  await page.getByRole("button", { name: "Add to project" }).click();
  await openProjectTools(page);
  await page.getByText("Interchange", { exact: true }).click();
  await expect(page.getByLabel("Import cut list", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close project tools", exact: true }).click();
  await page.getByRole("button", { name: "Save project from project header", exact: true }).click();
  await expect(page.getByRole("status", { name: "Project status" })).toHaveText("Saved");
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Export", exact: true })).toBeVisible();
  await expect(page.getByLabel("Import cut list")).toHaveCount(0);
});
