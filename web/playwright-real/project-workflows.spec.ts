import { readFile } from "node:fs/promises";
import type { Project } from "../src/generated/effect-api";
import { expect, test, connectContext } from "./fixtures";
import {
  openRealMedia,
  loadProject,
  saveProject,
  setRange,
  addSelectedMediaToProject,
} from "./actions";

test("two real clients recover from revision conflicts through unobstructed Settings navigation", async ({
  page,
  browser,
  app,
}) => {
  await openRealMedia(page);
  await setRange(page, 1000, 3000);
  const savedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      /\/api\/v2\/projects\/[^/]+$/.test(new URL(response.url()).pathname) &&
      response.status() === 200,
  );
  await saveProject(page);
  const saved = (await (await savedResponse).json()) as Project;
  const otherContext = await browser.newContext({ baseURL: app.baseURL });
  try {
    await connectContext(otherContext, app);
    const other = await otherContext.newPage();
    await other.goto("/");
    await loadProject(other, saved.id);
    await expect(other.getByLabel("Label cut 1")).toHaveValue("Segment 001");
    await page.getByLabel("Label cut 1").fill("First client's cut");
    await page.getByLabel("Label cut 1").press("Tab");
    await expect(page.getByRole("status", { name: "Project status" })).toHaveText("Saved");
    const conflict = other.waitForResponse(
      (response) => response.status() === 409 && response.request().method() === "PUT",
    );
    await other.getByLabel("Label cut 1").fill("Second client's cut");
    await other.getByLabel("Label cut 1").press("Tab");
    await conflict;
    await other.getByRole("button", { name: "Settings", exact: true }).click();
    const notice = other
      .getByRole("alert")
      .filter({ hasText: "Another client saved this project." });
    await expect(notice).toBeVisible();
    await expect(
      notice.getByRole("button", { name: "Save local work as new project" }),
    ).toBeVisible();
    await notice.getByRole("button", { name: "Reload remote project" }).click();
    await expect(notice).toHaveCount(0);
    await other.getByRole("button", { name: "Back to editor", exact: true }).click();
    await expect(other.getByLabel("Label cut 1")).toHaveValue("First client's cut");
    await other.getByRole("button", { name: "Settings", exact: true }).focus();
    await other.keyboard.press("Enter");
    const back = other.getByRole("button", { name: "Back to editor", exact: true });
    await expect(back).toBeVisible();
    await back.focus();
    await other.keyboard.press("Enter");
    await expect(other.getByLabel("Label cut 1")).toHaveValue("First client's cut");
  } finally {
    await otherContext.close();
  }
});

test("real interchange imports CSV and chapters and downloads their persisted cut lists", async ({
  page,
}, testInfo) => {
  await openRealMedia(page);
  await addSelectedMediaToProject(page);
  await page.getByRole("button", { name: "Project menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Project tools", exact: true }).click();
  await page.getByText("Interchange", { exact: true }).click();
  const csv = "start,end,label\n00:00:00.500,00:00:01.500,Opening\n";
  await page
    .getByLabel("Import cut list", { exact: true })
    .setInputFiles({ name: "review.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByText("Project loaded.", { exact: true })).toBeVisible();
  const chapters = "00:00:00.500 --> 00:00:01.500 Opening\n";
  await page.getByLabel("Import cut list", { exact: true }).setInputFiles({
    name: "review.chapters",
    mimeType: "text/plain",
    buffer: Buffer.from(chapters),
  });
  await expect(page.getByText("Project loaded.", { exact: true })).toBeVisible();
  for (const [button, filename, content] of [
    ["Download CSV cut list", "cutlist.csv", csv],
    ["Download chapters", "cutlist.chapters", chapters],
  ]) {
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: button, exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(filename);
    const path = testInfo.outputPath(filename);
    await download.saveAs(path);
    expect(await readFile(path, "utf8")).toBe(content);
  }
  await page.getByRole("button", { name: "Close project tools", exact: true }).click();
  await expect(page.getByLabel("Label cut 1")).toHaveValue("Opening");
  await page.reload();
  await expect(page.getByLabel("Label cut 1")).toHaveValue("Opening");
});
