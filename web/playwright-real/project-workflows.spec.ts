import type { Project } from "../src/generated/effect-api";
import { expect, test, connectContext } from "./fixtures";
import { openRealMedia, loadProject, saveProject, setRange } from "./actions";

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
    await loadProject(other, saved.id, saved.name);
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
