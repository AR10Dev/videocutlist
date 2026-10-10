import { expect, test } from "@playwright/test";

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

test("project save ignores playhead and unfinished cuts but persists undo", async ({ page }) => {
  const writes: unknown[] = [];
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
      return route.fulfill({ json: { folders: [], items: [media] } });
    if (url.pathname === `/api/v2/media/${media.id}`) return route.fulfill({ json: media });
    if (url.pathname === "/api/v2/media/status")
      return route.fulfill({ json: { state: "ready_with_media", message: "Ready" } });
    if (url.pathname === "/api/v2/settings") return route.fulfill({ json: {} });
    if (url.pathname === "/api/v2/destinations")
      return route.fulfill({ json: { destinations: [] } });
    if (url.pathname === "/api/v2/batches") return route.fulfill({ json: { items: [] } });
    if (request.method() === "PUT" && /^\/api\/v2\/projects\/[^/]+$/.test(url.pathname)) {
      const body = request.postDataJSON();
      writes.push(body);
      return route.fulfill({
        json: {
          ...body,
          id: url.pathname.split("/").at(-1),
          revision: writes.length,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
    }
    return route.fulfill({ status: 404 });
  });

  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: /camera\.mp4/ }).click();
  await page.getByRole("button", { name: "Add to project" }).click();
  await page.getByLabel("Timeline playhead").fill("500");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.getByLabel("Timeline playhead").fill("1000");
  await page.getByRole("button", { name: "Set out" }).click();
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);
  await page.getByRole("button", { name: "Save project from project header", exact: true }).click();
  await expect(page.getByRole("status", { name: "Project status" })).toHaveText("Saved");
  expect(writes).toHaveLength(1);

  await page.getByLabel("Timeline playhead").fill("1500");
  await page.getByRole("button", { name: "Set in" }).click();
  await page.clock.runFor(900);
  expect(writes).toHaveLength(1);
  await expect(page.getByRole("status", { name: "Project status" })).toHaveText("Saved");

  await page.keyboard.press("Control+z");
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(0);
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ revision: 1, items: [{ segments: [] }] });
});

test("project import remains dirty across conflict and recovery restores edits", async ({
  page,
}) => {
  const writes: { body: Record<string, unknown>; id: string }[] = [];
  let conflict = true;
  const imported = {
    schemaVersion: 2,
    name: "Imported edit",
    items: [
      {
        id: "i_aaaaaaaaaaaaaaaaaaaaaaaa",
        mediaId: media.id,
        segments: [{ startMs: 250, endMs: 1500, label: "Opening" }],
        exportOptions: {},
      },
    ],
  };
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
      return route.fulfill({ json: { folders: [], items: [media] } });
    if (url.pathname === `/api/v2/media/${media.id}`) return route.fulfill({ json: media });
    if (url.pathname === "/api/v2/media/status")
      return route.fulfill({ json: { state: "ready_with_media", message: "Ready" } });
    if (url.pathname === "/api/v2/settings") return route.fulfill({ json: {} });
    if (url.pathname === "/api/v2/destinations")
      return route.fulfill({ json: { destinations: [] } });
    if (url.pathname === "/api/v2/batches") return route.fulfill({ json: { items: [] } });
    if (request.method() === "PUT" && /^\/api\/v2\/projects\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").at(-1)!;
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ body, id });
      if (conflict) {
        conflict = false;
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "revision_conflict",
              message: "Project revision changed.",
              requestId: "browser-test",
            },
          },
        });
      }
      return route.fulfill({
        json: { ...body, id, revision: 1, updatedAt: "2026-01-01T00:00:00Z" },
      });
    }
    return route.fulfill({ status: 404 });
  });

  await page.goto("/");
  await page.locator(".project-menu > summary").click();
  await page.getByRole("button", { name: "Project tools", exact: true }).click();
  await page.getByText("Interchange", { exact: true }).click();
  await page.getByLabel("Import cut list", { exact: true }).setInputFiles({
    name: "review.videocutlist.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(page.getByLabel("Project name")).toHaveValue("Imported edit");
  await expect(page.getByText("Cut list imported. Save the project to keep it.")).toBeVisible();
  await page.getByRole("button", { name: "Close project tools", exact: true }).click();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.locator(".project-menu > summary").click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(page.locator(".project-sidebar-header strong")).toHaveText("Imported edit");
  await page.locator(".project-menu > summary").click();
  await page.getByRole("button", { name: "Save project from project header", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Another client saved this project");
  expect(writes[0].body).toMatchObject({ revision: 0, schemaVersion: 2, name: "Imported edit" });
  await page.getByRole("button", { name: "Save local work as new project" }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].body).toMatchObject({ revision: 0, name: "Imported edit" });

  await page.evaluate(
    (snapshot) => {
      localStorage.setItem("videocutlist.project-recovery.v1", JSON.stringify(snapshot));
    },
    {
      version: 1,
      projectId: "p_recovery-project1",
      revision: 3,
      schemaVersion: 2,
      name: "Recovered edit",
      items: imported.items,
      savedAt: 1_800_000_000_000,
    },
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Recover local edits" })).toBeVisible();
  await page.getByRole("button", { name: "Recover local edits" }).click();
  await expect(page.getByRole("status", { name: "Project status" })).toHaveText("Unsaved changes");
  await page.locator(".project-menu > summary").click();
  await page.getByRole("button", { name: "Project tools", exact: true }).click();
  await expect(page.getByLabel("Project name")).toHaveValue("Recovered edit");
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);
});
