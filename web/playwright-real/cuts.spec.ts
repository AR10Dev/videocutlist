import { expect } from "@playwright/test";
import { test } from "./fixtures";
import {
  openRealMedia as openMedia,
  openTask,
  startNewSegment,
  setRange,
  addSelectedMediaToProject,
} from "./actions";

test("task tabs expose selection, association, and keyboard navigation", async ({ page }) => {
  await page.goto("/");
  const detection = page.getByRole("tab", { name: "Auto-detect", exact: true });
  await expect(detection).toBeDisabled();
  await page.getByRole("button", { name: /sintel-trailer.mp4/ }).click();
  await page.getByRole("tab", { name: "Cuts", exact: true }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Export", exact: true })).toBeFocused();
  await expect(detection).toBeDisabled();
  await page.getByRole("tab", { name: "Cuts", exact: true }).click();
  await addSelectedMediaToProject(page);
  await expect(detection).toBeEnabled();
  const cuts = page.getByRole("tab", { name: "Cuts", exact: true });
  const exportTab = page.getByRole("tab", { name: "Export", exact: true });
  await expect(cuts).toHaveAttribute("aria-selected", "true");
  await expect(cuts).toHaveAttribute("aria-controls", "cuts-tabpanel");
  await cuts.press("ArrowRight");
  await expect(detection).toBeFocused();
  await detection.press("ArrowRight");
  await expect(exportTab).toBeFocused();
  await expect(exportTab).toHaveAttribute("aria-selected", "true");
  await exportTab.press("ArrowRight");
  await expect(cuts).toBeFocused();
  await exportTab.press("ArrowLeft");
  await expect(detection).toBeFocused();
  await expect(detection).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Auto-detect" })).toBeVisible();
});

test("typing a cut label keeps its input mounted across edits, selection, and reorder", async ({
  page,
}) => {
  await openMedia(page);
  await setRange(page, 100, 700);
  await startNewSegment(page);
  await setRange(page, 800, 900);
  const rows = page.getByRole("list", { name: "Selected cuts" }).getByRole("listitem");
  await expect(rows.nth(0)).toContainText("00:00.100");
  await expect(rows.nth(0)).toContainText("00:00.700");
  await expect(page.getByText("Segment 001", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Segment 002", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Set in", exact: true })).toBeEnabled();
  const first = rows.nth(0);
  const label = first.getByRole("textbox", { name: "Label cut 1" });
  const originalId = await first.getAttribute("data-segment-id");
  await label.fill("");
  await label.focus();
  for (const letter of "Opening") {
    await page.keyboard.type(letter);
    await expect(label).toBeFocused();
  }
  await expect(label).toHaveValue("Opening");
  await rows.nth(1).getByRole("button", { name: "Select cut 2" }).click();
  await expect(first.getByRole("textbox", { name: "Label cut 1" })).toHaveValue("Opening");
  await first.getByRole("button", { name: "Move cut 1 down" }).click();
  const moved = rows.nth(1);
  await expect(moved).toHaveAttribute("data-segment-id", originalId!);
  await expect(moved.getByRole("textbox", { name: "Label cut 2" })).toHaveValue("Opening");
  await moved.getByRole("textbox", { name: "Label cut 2" }).focus();
  await page.keyboard.type("!");
  await expect(moved.getByRole("textbox", { name: "Label cut 2" })).toBeFocused();
  await expect(moved.getByRole("textbox", { name: "Label cut 2" })).toHaveValue("Opening!");
  await moved.getByRole("button", { name: "Remove cut 2" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("00:00.800");
});

test("keyboard editing keeps drafts separate from active cuts and is discoverable", async ({
  page,
}) => {
  await openMedia(page);
  const playhead = page.getByLabel("Timeline playhead");
  const create = async (start: number, end: number) => {
    await playhead.fill(String(start));
    await page.locator("body").press("i");
    await playhead.fill(String(end));
    await page.locator("body").press("o");
    await page.locator("body").press("c");
  };

  await create(100, 700);
  await page.keyboard.press("Escape");
  await create(800, 900);
  const rows = page.getByRole("list", { name: "Selected cuts" }).getByRole("listitem");
  await expect(rows).toHaveCount(2);

  await rows.nth(0).getByRole("button", { name: "Select cut 1" }).click();
  await playhead.fill("400");
  await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
  await page.keyboard.press("i");
  await expect(page.locator("#timeline-description")).toContainText("In marker 00:00.400");
  await expect(page.getByRole("textbox", { name: "Cut 1 In", exact: true })).toHaveValue(
    "00:00.100",
  );
  await playhead.fill("850");
  await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
  await page.keyboard.press("o");
  await expect(page.getByText(/overlap another cut/)).toBeVisible();

  await playhead.fill("500");
  await rows.nth(0).getByRole("button", { name: "Select cut 1" }).click();
  await playhead.fill("500");
  await page.getByRole("heading", { name: "Timeline" }).focus();
  await page.keyboard.press("b");
  await expect(rows).toHaveCount(3);
  await page.keyboard.press("Delete");
  await expect(rows).toHaveCount(2);
  await page.keyboard.press("Control+z");
  await expect(rows).toHaveCount(3);
  await page.keyboard.press("Control+y");
  await expect(rows).toHaveCount(2);

  await page.keyboard.press("Shift+/");
  await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
  await expect(page.getByText("C Start a new segment draft", { exact: true })).toBeVisible();
  await expect(page.getByText("Preview cuts in order", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toHaveCount(0);
});

test("adds, selects, splits, and safely removes cuts with the redesigned controls", async ({
  page,
}) => {
  await openMedia(page);
  await expect(page.getByRole("tab", { name: "Cuts" })).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByText(
      "Set In and Out on the timeline; a valid range becomes one selected segment automatically.",
    ),
  ).toBeVisible();

  await setRange(page, 1000, 3000);
  await expect(page.locator(".cut-summary")).toHaveText("1 cut · 00:02.000");
  await page.getByRole("checkbox", { name: "Include cut 1 in export" }).uncheck();
  await expect(page.locator(".cut-summary")).toHaveText("1 cut · 0 included · 00:00.000");
  await page.getByRole("checkbox", { name: "Include cut 1 in export" }).check();
  await expect(page.locator(".cut-summary")).toHaveText("1 cut · 00:02.000");
  const cuts = page.getByRole("list", { name: /Selected cuts/ }).getByRole("listitem");
  await expect(cuts).toHaveCount(1);
  await expect(cuts.first().getByRole("button", { name: "Select cut 1" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const startHandle = page.getByRole("slider", { name: "Resize cut 1 start" });
  const originalStart = Number(await startHandle.getAttribute("aria-valuenow"));
  await startHandle.press("ArrowRight");
  expect(Number(await startHandle.getAttribute("aria-valuenow"))).toBeGreaterThan(originalStart);
  await startHandle.press("ArrowLeft");

  await page.getByLabel("Timeline playhead").fill("2000");
  await page.getByRole("heading", { name: "Timeline" }).focus();
  await page.keyboard.press("b");
  await expect(cuts).toHaveCount(2);
  await page.getByRole("button", { name: /Move cut 1 down/ }).click();
  await expect(cuts.first().getByRole("button", { name: "Select cut 1" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByLabel("Label cut 2").focus();
  await page.keyboard.press("Backspace");
  await expect(cuts).toHaveCount(2);
  await page.getByRole("heading", { name: "Timeline" }).focus();
  await page.keyboard.press("Delete");
  await expect(cuts).toHaveCount(1);

  await expect(page.locator(".timeline-visual")).toBeVisible();
  await openTask(page, "Export");
  await expect(page.getByLabel(/Output arrangement/)).toContainText("Combine selected cuts");
  await expect(page.getByLabel("Processing")).toContainText("Fast copy");
  await expect(page.getByText(/not frame-exact/)).toBeVisible();
});
