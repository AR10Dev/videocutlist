import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { addSelectedMediaToProject } from "./actions";
async function addSegment(page: Page) {
  const playhead = page.getByLabel("Timeline playhead");
  await playhead.fill("100");
  await page.getByRole("button", { name: "Set in" }).click();
  await playhead.fill("700");
  await page.getByRole("button", { name: "Set out" }).click();
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);
  await expect(page.locator('button[aria-label="Select cut 1"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

async function openMediaChooser(page: Page) {
  const change = page.getByRole("button", { name: "Change video" });
  if (await change.isVisible()) await change.click();
}

test("the first cut adds media automatically and reselecting never duplicates it", async ({
  page,
}) => {
  let exportBody: Record<string, unknown> | undefined;
  page.on("request", (request) => {
    if (request.url().endsWith("/exports"))
      exportBody = request.postDataJSON() as Record<string, unknown>;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Select sintel-trailer.mp4" }).click();
  const selectedMedia = page.getByLabel("Selected media");
  await expect(page.getByRole("button", { name: "Add to project" })).toHaveCount(0);
  await expect(selectedMedia).toContainText("sintel-trailer.mp4");

  await expect(page.locator(".preview-only-notice")).toHaveCount(0);
  await expect(page.getByText(/Preview only · Your first valid cut/)).toHaveCount(0);
  await addSegment(page);
  await expect(selectedMedia).toContainText("sintel-trailer.mp4");

  await openMediaChooser(page);
  await page.getByRole("button", { name: "Select sintel-trailer.mkv" }).click();
  await expect(page.getByRole("button", { name: "Add to project" })).toHaveCount(0);
  await expect(selectedMedia).toContainText("sintel-trailer.mkv");
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  const exportSummary = page.getByLabel("Export plan");
  await expect(exportSummary).toContainText("0 · 00:00.000 requested");
  await expect(page.getByRole("button", { name: "Create clips" })).toBeDisabled();

  await addSelectedMediaToProject(page);
  await expect(selectedMedia).toContainText("sintel-trailer.mkv");

  await openMediaChooser(page);
  await page.getByRole("button", { name: "Select sintel-trailer.mp4" }).click();
  await expect(page.getByRole("button", { name: "Add to project" })).toHaveCount(0);
  await expect(selectedMedia).toContainText("sintel-trailer.mp4");

  await page.getByRole("tab", { name: "Export", exact: true }).click();
  const exportPanel = page.getByRole("region", { name: "Export" });
  const activeScope = exportPanel.getByRole("radio", { name: "Active media item" });
  const selectedScope = exportPanel.getByRole("radio", { name: "Selected project items" });
  await expect(activeScope).toBeChecked();
  await expect(exportSummary).toContainText("sintel-trailer.mp4");
  await expect(exportSummary).toContainText("1 · 00:00.600 requested");
  await expect(exportPanel.getByLabel("Project items to export")).toHaveCount(0);

  await selectedScope.check();
  await expect(exportSummary).toContainText("2 project items");
  await expect(exportPanel.getByRole("checkbox", { name: "sintel-trailer.mp4" })).toBeChecked();
  await expect(exportPanel.getByRole("checkbox", { name: "sintel-trailer.mkv" })).toBeChecked();

  await activeScope.check();
  await expect(exportSummary).toContainText("sintel-trailer.mp4");
  await expect(exportSummary).toContainText("1 · 00:00.600 requested");
  await page.getByRole("button", { name: "Create clips" }).click();
  await expect(
    page.getByRole("region", { name: "Current batch" }).getByText("succeeded", { exact: true }),
  ).toHaveCount(1, { timeout: 30_000 });
  expect(exportBody?.itemIds).toEqual([expect.any(String)]);
});
