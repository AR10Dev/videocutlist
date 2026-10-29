import { expect, test } from "./fixtures";

test("pressing Start again creates a second segment without overwriting the first", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select sintel-trailer.mp4" }).click();
  const playhead = page.getByLabel("Timeline playhead");
  await playhead.fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await playhead.fill("300");
  await page.getByRole("button", { name: "Set out" }).click();
  await playhead.fill("500");
  await page.getByRole("button", { name: "Set in" }).click();
  await expect(page.locator("#timeline-description")).toContainText("In marker 00:00.500");
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);
  await playhead.fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(2);
  await expect(
    page.getByRole("list", { name: "Selected cuts" }).getByRole("listitem").nth(0),
  ).toContainText("00:00.100");
  await expect(
    page.getByRole("list", { name: "Selected cuts" }).getByRole("listitem").nth(1),
  ).toContainText("00:00.500");
});
