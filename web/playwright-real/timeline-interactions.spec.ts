import { expect, test } from "./fixtures";
import {
  openRealMedia as openMedia,
  openTask,
  startNewSegment,
  setRange,
  addSelectedMediaToProject,
} from "./actions";

test("keeps the inspector contextual until media is selected", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(page.locator(".project-sidebar-header strong")).toHaveText("Untitled project");
  await expect(
    page.getByText("Add a video to your project by making your first valid cut."),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Export", exact: true })).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Detection" })).not.toBeVisible();
  await expect(page.getByText("Default cut strategy")).not.toBeVisible();
  await expect(page.getByText("Default filename template")).not.toBeVisible();

  await page.getByRole("button", { name: /sintel-trailer.mp4/ }).click();

  await expect(page.getByRole("heading", { name: "Cuts" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Export", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Auto-detect", exact: true })).toBeVisible();
});

test("covers the responsive workspace and keyboard editing workflow", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  const projectStatus = page.getByLabel("Project status");
  await expect(page.locator(".project-sidebar-header strong")).toHaveText("Untitled project");
  await expect(projectStatus).toContainText("Not saved yet");
  await page.getByRole("button", { name: /sintel-trailer.mp4/ }).focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.getByLabel("Preview player").evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThanOrEqual(2);
  await addSelectedMediaToProject(page);
  const taskToggle = page.getByRole("button", { name: /editing tools/ });
  if ((await taskToggle.getAttribute("aria-expanded")) === "false") await taskToggle.click();

  const exportTab = page.getByRole("tab", { name: "Export", exact: true });
  const detectionTab = page.getByRole("tab", { name: "Auto-detect", exact: true });
  await exportTab.focus();
  await page.keyboard.press("Enter");
  await expect(exportTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Export options")).toBeVisible();
  await expect(page.getByText("Export options").locator("..")).toHaveAttribute("open", "");
  await page.keyboard.press("ArrowLeft");
  await expect(detectionTab).toHaveAttribute("aria-selected", "true");

  await expect(page.getByLabel("Preview source range")).toHaveCount(0);
  await page.getByRole("heading", { name: "Timeline" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("i");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  await openTask(page, "Cuts");
  const rows = page.getByRole("list", { name: "Selected cuts" }).getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Select cut 1" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("list", { name: "Selected cuts" })).toContainText("00:02.000");
  await openTask(page, "Project");
  const mediaToggle = page.getByRole("button", { name: /media library/ });
  const closeTasks = page.getByRole("button", { name: "Close segments panel" });
  if (await closeTasks.isVisible()) await closeTasks.click();
  if ((await mediaToggle.getAttribute("aria-expanded")) === "false") await mediaToggle.click();
  await page.getByRole("button", { name: "Save project from project header", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".project-sidebar-header strong")).toHaveText("Untitled project");
  await expect(projectStatus.getByText("Saved", { exact: true })).toBeVisible();
  const closeDrawer = page.getByRole("button", { name: "Close open panel", exact: true });
  if (await closeDrawer.isVisible()) await closeDrawer.click({ position: { x: 385, y: 2 } });
  if ((await taskToggle.getAttribute("aria-expanded")) === "false") await taskToggle.click();
  await expect(taskToggle).toHaveAttribute("aria-expanded", "true");

  await expect(exportTab).toBeVisible();
  await exportTab.focus();
  await expect(exportTab).toBeFocused();
  await exportTab.press("Enter");
  await expect(exportTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Select none" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select all" })).toHaveCount(0);
  await exportTab.focus();
  await page.keyboard.press("Enter");
  const startExport = page.getByRole("button", { name: "Create clips" });
  await expect(startExport).toBeEnabled();
  await startExport.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("region", { name: "Current batch" }).getByText("succeeded", { exact: true }),
  ).toHaveCount(1, { timeout: 30_000 });

  await detectionTab.focus();
  await page.keyboard.press("Enter");
  await expect(detectionTab).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Find pauses" }).focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.getByLabel("Detection candidates").getByRole("listitem").count(), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
});

test("renders separate timeline lanes and seeks through their shared interaction area", async ({
  page,
}) => {
  await openMedia(page);

  const ruler = page.getByRole("img", { name: "Timeline ruler" });
  const thumbnails = page.getByRole("img", { name: "Thumbnail lane" });
  const waveform = page.getByRole("img", { name: "Waveform lane" });
  const [rulerBounds, thumbnailBounds, waveformBounds] = await Promise.all([
    ruler.boundingBox(),
    thumbnails.boundingBox(),
    waveform.boundingBox(),
  ]);
  expect(rulerBounds).not.toBeNull();
  expect(thumbnailBounds).not.toBeNull();
  expect(waveformBounds).not.toBeNull();
  expect(rulerBounds!.y + rulerBounds!.height).toBeLessThanOrEqual(thumbnailBounds!.y);
  expect(thumbnailBounds!.y + thumbnailBounds!.height).toBeLessThanOrEqual(waveformBounds!.y);

  const timeline = page.locator(".timeline-visual");
  const playhead = page.getByLabel("Timeline playhead");
  const duration = Number(await playhead.getAttribute("max"));
  expect(duration).toBeGreaterThan(0);
  const bounds = await timeline.boundingBox();
  expect(bounds).not.toBeNull();
  await timeline.click({ position: { x: bounds!.width / 4, y: bounds!.height / 2 } });
  await expect
    .poll(async () => Number(await playhead.inputValue()))
    .toBeGreaterThanOrEqual(duration / 4 - 100);
  expect(Number(await playhead.inputValue())).toBeLessThanOrEqual(duration / 4 + 100);

  const currentBounds = await timeline.boundingBox();
  const playheadBounds = await page.locator(".timeline-playhead").boundingBox();
  expect(currentBounds).not.toBeNull();
  expect(playheadBounds).not.toBeNull();
  expect(Math.abs(playheadBounds!.y - currentBounds!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(playheadBounds!.height - currentBounds!.height)).toBeLessThanOrEqual(2);

  await setRange(page, 1000, 7000);
  const outMarker = page.locator(".cut-handle-end");
  const outBounds = await outMarker.boundingBox();
  expect(outBounds).not.toBeNull();
  await page.mouse.move(outBounds!.x + outBounds!.width / 2, outBounds!.y + 8);
  await page.mouse.down();
  const originalOut = Number(await outMarker.getAttribute("aria-valuenow"));
  await page.mouse.move(currentBounds!.x + (currentBounds!.width * 4) / 5, currentBounds!.y + 8, {
    steps: 3,
  });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await outMarker.getAttribute("aria-valuenow")))
    .toBeGreaterThan(originalOut);
  await expect
    .poll(async () => Number(await outMarker.getAttribute("aria-valuenow")))
    .toBeGreaterThan(duration * 0.79);
  await expect(page.locator("#timeline-description")).toContainText("Out marker");

  const inMarker = page.locator(".cut-handle-start");
  const markerBounds = await inMarker.boundingBox();
  const settledBounds = await timeline.boundingBox();
  expect(markerBounds).not.toBeNull();
  expect(markerBounds!.width).toBeGreaterThanOrEqual(12);
  const handleMetrics = await inMarker.evaluate((element) => ({
    visualWidth: Number.parseFloat(getComputedStyle(element).width),
    hitWidth: Number.parseFloat(getComputedStyle(element, "::before").width),
  }));
  expect(handleMetrics.visualWidth).toBe(12);
  expect(handleMetrics.hitWidth).toBeGreaterThanOrEqual(12);
  const activeSegmentBounds = await page.locator(".timeline-segment.is-active").boundingBox();
  expect(activeSegmentBounds).not.toBeNull();
  expect(handleMetrics.hitWidth).toBeLessThanOrEqual(activeSegmentBounds!.width / 2 + 1);
  expect(settledBounds).not.toBeNull();
  await page.mouse.move(markerBounds!.x + markerBounds!.width / 2, markerBounds!.y + 8);
  await page.mouse.down();
  await page.mouse.move(settledBounds!.x + settledBounds!.width / 5, settledBounds!.y + 8, {
    steps: 3,
  });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await inMarker.getAttribute("aria-valuenow")))
    .toBeGreaterThan(duration * 0.19);
  await expect
    .poll(async () => Number(await inMarker.getAttribute("aria-valuenow")))
    .toBeLessThan(duration * 0.21);
  await expect(page.locator("#timeline-description")).toContainText("In marker");

  await timeline.click({
    position: { x: (settledBounds!.width * 9) / 10, y: settledBounds!.height / 2 },
  });
  await expect
    .poll(async () => Number(await playhead.inputValue()))
    .toBeGreaterThanOrEqual(duration * 0.89);
  await expect
    .poll(async () => Number(await playhead.inputValue()))
    .toBeLessThanOrEqual(duration * 0.91);

  await startNewSegment(page);
  await setRange(page, 8500, 9500);
  const timelineSegments = page.locator(".timeline-segment");
  await expect(timelineSegments).toHaveCount(2);
  await timelineSegments.nth(1).click();
  await expect(timelineSegments.nth(0)).toHaveAttribute("aria-pressed", "false");
  await expect(timelineSegments.nth(1)).toHaveAttribute("aria-pressed", "true");
});
