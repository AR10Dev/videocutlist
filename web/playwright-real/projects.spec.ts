import type { Project } from "../src/generated/effect-api";
import { addMediaWithSegments, loadProject } from "./actions";
import { connectContext, expect, test } from "./fixtures";

test("saves real cuts and restores them after a process restart", async ({
  page,
  context,
  app,
  request,
}) => {
  await page.goto("/");
  await addMediaWithSegments(page, "sintel-trailer.mp4");
  await page.getByRole("button", { name: "Project menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Project tools", exact: true }).click();
  await page.getByLabel("Project name").fill("Restart persistence");
  const savedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      /\/api\/v2\/projects\/[^/]+$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const response = await savedResponse;
  expect(response.status()).toBe(200);
  const saved = (await response.json()) as Project;
  expect(saved.items).toHaveLength(1);
  expect(saved.items[0].segments).toHaveLength(2);
  await page.getByRole("button", { name: "Close project tools", exact: true }).click();
  await expect(page.getByRole("status", { name: "Project status" })).toHaveText("Saved");
  await page.reload();
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(2);

  await app.restart();
  await connectContext(context, app);
  await page.goto(app.baseURL);
  await loadProject(page, saved.id, saved.name);
  await expect(page.locator(".project-sidebar-header strong")).toHaveText(saved.name);
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(2);
  const persisted = await request.get(`${app.baseURL}/api/v2/projects/${saved.id}`, {
    headers: { Authorization: `Bearer ${app.token}` },
  });
  expect(persisted.status()).toBe(200);
  expect(((await persisted.json()) as Project).items).toEqual(saved.items);
});
