import { expect, test } from "@playwright/test";
import { mediaFixture } from "./fixtures";
import { mockWorkspaceApi } from "./workspace-api";

const origin = "http://127.0.0.1:8787";

test("project save ignores playhead and unfinished cuts but persists undo", async ({ page }) => {
  const writes: unknown[] = [];
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
  });
  await mockWorkspaceApi(page, writes);

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
        mediaId: mediaFixture.id,
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
  await mockWorkspaceApi(page, []);
  await page.route(`${origin}/api/v2/projects/*`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "PUT" || !/^\/api\/v2\/projects\/[^/]+$/.test(url.pathname))
      return route.fallback();
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
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Project menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Project tools", exact: true }).click();
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
  await page.getByRole("button", { name: "Project menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "New project", exact: true }).click();
  await expect(page.locator(".project-sidebar-header strong")).toHaveText("Imported edit");
  await page.getByRole("button", { name: "Project menu", exact: true }).click();
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
  await page.getByRole("button", { name: "Project menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Project tools", exact: true }).click();
  await expect(page.getByLabel("Project name")).toHaveValue("Recovered edit");
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);
});
