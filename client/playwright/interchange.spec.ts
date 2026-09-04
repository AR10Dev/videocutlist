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
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByRole("textbox", { name: "Timecode" }).fill("0:00.500");
  await page.getByRole("textbox", { name: "Timecode" }).press("Enter");
  await page.getByRole("button", { name: "Set out" }).click();
  await page.getByRole("button", { name: /Add cut/ }).click();
  await page.getByRole("tab", { name: "Project" }).click();
  await page.getByRole("button", { name: "Save project" }).click();
  await page.getByRole("tab", { name: "Export" }).click();
  await expect(page.getByRole("button", { name: "Export item" })).toBeEnabled();
  await page.getByRole("button", { name: "Export item" }).click();
  await expect(page.getByRole("button", { name: "Cancel export" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel export" }).click();
  await deleteSeen;
  await page.getByRole("button", { name: /second.mp4/ }).click();
  await page.getByRole("tab", { name: "Project" }).click();
  releaseDelete();
  await expect.poll(() => deleteAborted).toBe(true);
  releaseOldMetadata();
  await expect(
    page.getByRole("list", { name: "Project media items" }).getByRole("button", {
      name: "second.mp4",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("tab", { name: "Export" }).click();
  await expect(page.getByText("Export cancelled.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel export" })).not.toBeVisible();
});

test("project interchange controls wait for media selection", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a video to begin" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Project", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Export", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Detection", exact: true })).toBeDisabled();
  await expect(
    page.getByText("Select a video from the Media library to unlock the editing workspace."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Export CSV" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Export chapters" })).not.toBeVisible();
  await expect(page.getByLabel("Import CSV or chapters")).not.toBeVisible();
});

test("gates interchange exports until the project is persisted", async ({ page }) => {
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
  await page.getByRole("tab", { name: "Project" }).click();
  await page.getByText("Interchange", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Export chapters" })).toBeDisabled();
  await expect(
    page.getByText("Save the project before importing or exporting CSV or chapters."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Export chapters" })).toBeEnabled();
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
  await expect(page.getByLabel("Import CSV or chapters")).toHaveCount(0);

  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await page.getByRole("tab", { name: "Project" }).click();
  await page.getByText("Interchange", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeVisible();
  await page.getByRole("tab", { name: "Export" }).click();
  await expect(page.getByRole("heading", { name: "Export" })).toBeVisible();
  await page.getByRole("tab", { name: "Project" }).click();
  await expect(page.getByLabel("Import cut list")).toBeVisible();
  await expect(page.getByLabel("Import CSV or chapters")).toHaveCount(0);

  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByLabel("Import CSV or chapters")).toBeVisible();
});
