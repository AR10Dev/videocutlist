import { expect, test } from "@playwright/test";

test("project interchange controls wait for media selection", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Export CSV" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Export chapters" })).not.toBeVisible();
  await expect(page.getByLabel("Import CSV or chapters")).not.toBeVisible();
});
