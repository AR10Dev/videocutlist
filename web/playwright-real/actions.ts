import { expect, type Page } from "@playwright/test";

export async function openProjectControls(page: Page) {
  const mediaToggle = page.getByRole("button", { name: /media library/ }).first();
  if ((await mediaToggle.getAttribute("aria-expanded")) === "false") {
    const taskToggle = page.getByRole("button", { name: /editing tools/ }).first();
    if ((await taskToggle.getAttribute("aria-expanded")) === "true")
      await taskToggle.press("Escape");
    await mediaToggle.click();
  }
}

export async function openTask(page: Page, name: "Cuts" | "Project" | "Export" | "Detection") {
  if (name === "Project") return openProjectControls(page);
  const taskToggle = page.getByRole("button", { name: /editing tools/ }).first();
  if ((await taskToggle.getAttribute("aria-expanded")) === "false") await taskToggle.click();
  await page
    .getByRole("tab", { name: name === "Detection" ? "Auto-detect" : name, exact: true })
    .click();
}

export async function newProject(page: Page) {
  await openProjectControls(page);
  await page.getByRole("button", { name: "Project menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "New project" }).click();
}

export async function startNewSegment(page: Page) {
  await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
  await page.keyboard.press("c");
}

export async function setRange(page: Page, start: number, end: number) {
  const playhead = page.getByLabel("Timeline playhead");
  await playhead.fill(String(start));
  await page.getByRole("button", { name: "Set in" }).click();
  await playhead.fill(String(end));
  await page.getByRole("button", { name: "Set out" }).click();
}

export async function addSelectedMediaToProject(page: Page) {
  // Create membership automatically, then leave an empty item for these workflows.
  await setRange(page, 100, 700);
  await openTask(page, "Cuts");
  await page.locator(".cut-menu summary").click();
  await page.getByRole("button", { name: "Remove cut 1", exact: true }).click();
  await page.getByLabel("Timeline playhead").fill("0");
}

export async function saveProject(page: Page) {
  await openProjectControls(page);
  const saving = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      /\/api\/v2\/projects\/[^/]+$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole("button", { name: "Save project from project header", exact: true }).click();
  expect((await saving).status()).toBe(200);
  await expect(page.getByRole("status", { name: "Project status" })).toHaveText("Saved");
}

export async function loadProject(page: Page, id: string, name: string) {
  await page.getByRole("button", { name: "Project menu", exact: true }).click();
  const loading = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/v2/projects/${id}` &&
      response.request().method() === "GET",
  );
  await page.getByRole("menuitem", { name: "Load project", exact: true }).click();
  await page
    .getByRole("list", { name: "Saved projects" })
    .getByRole("button", { name, exact: true })
    .click();
  const confirmation = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  if (await confirmation.isVisible())
    await confirmation.getByRole("button", { name: "Discard changes" }).click();
  expect((await loading).status()).toBe(200);
  await page.getByRole("button", { name: "Close project tools" }).click();
}

export async function openRealMedia(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Select sintel-trailer.mp4", exact: true }).click();
}

export async function addSegment(page: Page, startMs: number, endMs: number, startNew = false) {
  if (startNew) {
    await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
    await page.keyboard.press("c");
  }
  const playhead = page.getByLabel("Timeline playhead");
  await playhead.fill(String(startMs));
  await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
  await page.keyboard.press("i");
  await playhead.fill(String(endMs));
  await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
  await page.keyboard.press("o");
}

export async function addMediaWithSegments(page: Page, name: string) {
  await page.getByRole("button", { name: `Select ${name}` }).click();
  await addSegment(page, 1_000, 3_000);
  await addSegment(page, 4_000, 6_000, true);
}
