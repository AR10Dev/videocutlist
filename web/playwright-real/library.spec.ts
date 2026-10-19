import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";

test("a real rescan discovers removed inputs and shows actionable empty-library guidance", async ({
  page,
  app,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Select sintel-trailer.mp4", exact: true }),
  ).toBeVisible();
  for (const name of ["sintel-trailer.mp4", "sintel-trailer.mkv"])
    await rm(join(app.mediaRoot, name));
  await page.getByRole("button", { name: "Refresh media", exact: true }).click();
  const status = page.getByRole("region", { name: "Media library status" });
  await expect(status).toContainText("No supported media was found.");
  await expect(status).toContainText("Mount supported media, then Refresh to index it");
  await expect(status.getByRole("status")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^Select sintel-trailer/ })).toHaveCount(0);
  await expect(page.locator(".project-sidebar-header strong")).toHaveText("Untitled project");
  await expect(page.getByRole("heading", { name: "Choose a video to begin" })).toBeVisible();
});
