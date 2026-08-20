import { expect, test } from "@playwright/test";

test("project exposes CSV and chapter interchange controls", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export chapters" })).toBeVisible();
  await expect(page.getByLabel("Import CSV or chapters")).toBeVisible();
});
