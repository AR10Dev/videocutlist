import { expect, test } from "./fixtures";
import { openRealMedia as chooseMedia, setRange } from "./actions";
import { CENTER_MIN_WIDTH, WORKSPACE_EDGE_SPACE } from "../src/app/panelPreferences";

test("project menu delegates keyboard navigation, dismissal, and dialog focus", async ({
  page,
}) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Project menu", exact: true });
  await trigger.focus();
  await trigger.press("ArrowDown");
  const newProject = page.getByRole("menuitem", { name: "New project", exact: true });
  await expect(newProject).toBeFocused();
  await newProject.press("End");
  await expect(page.getByRole("menuitem", { name: "Keyboard help" })).toBeFocused();
  await expect(page.getByText("Panel layout", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /Reset .* panel size/ })).toHaveCount(0);
  await page.keyboard.press("Home");
  await expect(newProject).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByRole("menuitem", { name: "Project tools", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Project tools", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Close project tools" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByRole("menuitem", { name: "Keyboard help" }).click();
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  await expect(help.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(help.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.locator(".modal-backdrop").click({ position: { x: 8, y: 8 } });
  await expect(help).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByRole("main").click({ position: { x: 700, y: 550 } });
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("keyboard help restores its timeline launcher and task tabs retain mounted views", async ({
  page,
}) => {
  await chooseMedia(page);
  const timeline = page.getByRole("heading", { name: "Timeline", exact: true });
  await timeline.focus();
  await page.keyboard.press("Shift+/");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(timeline).toBeFocused();

  const cuts = page.getByRole("tab", { name: "Cuts", exact: true });
  const exportTab = page.getByRole("tab", { name: "Export", exact: true });
  await cuts.focus();
  await cuts.press("End");
  await expect(exportTab).toBeFocused();
  await expect(exportTab).toHaveAttribute("aria-selected", "true");
  await page.getByText("Advanced naming", { exact: true }).click();
  await page
    .getByLabel("Filename template", { exact: true })
    .fill("{source}-custom-{segment}.{ext}");
  await exportTab.press("Home");
  await expect(cuts).toBeFocused();
  await cuts.press("ArrowRight");
  await expect(exportTab).toBeFocused();
  await expect(page.getByLabel("Filename template", { exact: true })).toHaveValue(
    "{source}-custom-{segment}.{ext}",
  );
});

test("sidebar-only resize updates timeline measurements and canvas resolution", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1717, height: 1005 });
  await chooseMedia(page);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("timeline-zoom", { detail: 2 }));
  });
  const scroller = page.locator(".timeline-scroll");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollWidth / element.clientWidth))
    .toBeGreaterThan(1.9);
  await scroller.evaluate((element) => {
    element.scrollLeft = 100;
  });
  const rulerStart = page.locator(".timeline-ruler span").first();
  await expect(rulerStart).not.toHaveText("00:00.000");
  const previousRulerStart = await rulerStart.textContent();
  const previousWidth = await scroller.evaluate((element) => element.clientWidth);
  const canvas = page.locator(".timeline-canvas");
  const previousCanvasWidth = await canvas.evaluate((element: HTMLCanvasElement) => element.width);
  await page.evaluate(() => {
    document.documentElement.dataset.resizeEvents = "0";
    window.addEventListener("resize", () => {
      const root = document.documentElement;
      root.dataset.resizeEvents = String(Number(root.dataset.resizeEvents) + 1);
    });
  });
  const resizer = page.locator(".media-resizer");
  await resizer.focus();
  for (let index = 0; index < 8; index++) await resizer.press("ArrowRight");
  await expect
    .poll(() => scroller.evaluate((element) => element.clientWidth))
    .toBeLessThan(previousWidth);
  await expect(rulerStart).not.toHaveText(previousRulerStart!);
  await expect
    .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width))
    .toBeLessThan(previousCanvasWidth);
  await expect
    .poll(() =>
      canvas.evaluate((element: HTMLCanvasElement) => {
        const bounds = element.getBoundingClientRect();
        const scale = Math.min(
          devicePixelRatio || 1,
          8192 / Math.max(1, bounds.width),
          2048 / Math.max(1, bounds.height),
        );
        return Math.abs(element.width - Math.max(1, Math.round(bounds.width * scale)));
      }),
    )
    .toBe(0);
  expect(await page.evaluate(() => document.documentElement.dataset.resizeEvents)).toBe("0");
});

test("desktop resize clamps open panels without reopening collapsed or hidden panels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1717, height: 1005 });
  await page.addInitScript(() => {
    localStorage.setItem(
      "videocutlist.workspace-panels.v1",
      JSON.stringify({
        mediaWidth: 360,
        segmentsWidth: 420,
        mediaCollapsed: false,
        segmentsCollapsed: false,
      }),
    );
  });
  await chooseMedia(page);
  const mediaToggle = page.getByRole("button", { name: /media library/ }).first();
  const segmentsToggle = page.getByRole("button", { name: /editing tools/ }).first();
  await expect(mediaToggle).toHaveAttribute("aria-expanded", "true");
  await expect(segmentsToggle).toHaveAttribute("aria-expanded", "true");
  const panelWidths = () =>
    page.locator(".app-shell").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        media: Number.parseFloat(style.getPropertyValue("--media-panel-width")),
        segments: Number.parseFloat(style.getPropertyValue("--segments-panel-width")),
      };
    });
  const workspaceGeometry = () =>
    page.locator(".app-shell").evaluate((element) => {
      const shell = element.getBoundingClientRect();
      const rightmost = [
        "#media-panel",
        ".media-resizer",
        ".editor-panel",
        ".segments-resizer",
        "#segments-panel",
      ].reduce((right, selector) => {
        const panel = element.querySelector(selector);
        return Math.max(right, panel?.getBoundingClientRect().right ?? right);
      }, shell.left);
      return {
        editorWidth: element.querySelector(".editor-panel")?.getBoundingClientRect().width ?? 0,
        overflow: rightmost - shell.right,
      };
    });
  await expect.poll(panelWidths).toEqual({ media: 360, segments: 420 });

  await page.setViewportSize({ width: 1100, height: 1005 });
  await expect
    .poll(async () => {
      const widths = await panelWidths();
      return widths.media + widths.segments;
    })
    .toBeLessThanOrEqual(1100 - CENTER_MIN_WIDTH - WORKSPACE_EDGE_SPACE);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(1100);
  await expect
    .poll(async () => (await workspaceGeometry()).editorWidth)
    .toBeGreaterThanOrEqual(CENTER_MIN_WIDTH);
  await expect.poll(async () => (await workspaceGeometry()).overflow).toBeLessThanOrEqual(0);
  await expect(mediaToggle).toHaveAttribute("aria-expanded", "true");
  await expect(segmentsToggle).toHaveAttribute("aria-expanded", "true");

  await mediaToggle.click();
  await expect(mediaToggle).toHaveAttribute("aria-expanded", "false");
  await page.setViewportSize({ width: 1200, height: 1005 });
  await expect(mediaToggle).toHaveAttribute("aria-expanded", "false");

  await mediaToggle.click();
  await expect(mediaToggle).toHaveAttribute("aria-expanded", "true");
  const mediaPanel = page.locator("#media-panel");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(mediaPanel).toHaveAttribute("aria-hidden", "true");
  await page.setViewportSize({ width: 1250, height: 1005 });
  await expect(mediaPanel).toHaveAttribute("aria-hidden", "true");
});

test("filename preferences enforce the export server's UTF-8 template limit", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const template = page.getByLabel("Filename template");
  await template.fill("é".repeat(80));
  await expect(template).toHaveValue("é".repeat(80));
  await template.fill("é".repeat(81));
  await expect(template).toHaveValue("é".repeat(80));
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Filename template")).toHaveValue("é".repeat(80));
});

test("editing remains usable with 2x CSS zoom", async ({ page }) => {
  // This intentionally exercises CSS zoom at a narrow viewport, not browser page zoom.
  await page.setViewportSize({ width: 640, height: 900 });
  await chooseMedia(page);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  const layout = await page.evaluate(() => ({
    zoom: getComputedStyle(document.documentElement).zoom,
    hasPageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  expect(layout.zoom).toBe("2");
  expect(layout.hasPageOverflow).toBe(false);

  const segmentsToggle = page.getByRole("button", { name: /editing tools/ }).first();
  await expect(segmentsToggle).toBeVisible();
  if ((await segmentsToggle.getAttribute("aria-expanded")) === "false")
    await segmentsToggle.click();
  await expect(segmentsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#segments-panel")).toHaveAttribute("aria-hidden", "false");
  await page.getByRole("tab", { name: "Cuts", exact: true }).press("Escape");
  await expect(segmentsToggle).toBeFocused();
});

test("onboarding focuses Media and Export remains reachable with tasks open", async ({ page }) => {
  await page.goto("/");
  const mediaToggle = page.getByRole("button", { name: /media library/ }).first();
  const segmentsToggle = page.getByRole("button", { name: /editing tools/ }).first();
  if ((await mediaToggle.getAttribute("aria-expanded")) === "true") await mediaToggle.click();
  if ((await segmentsToggle.getAttribute("aria-expanded")) === "true") await segmentsToggle.click();
  await page.getByRole("button", { name: "Choose a video" }).click();
  await expect(
    page.getByRole("button", { name: /^Select sintel-trailer\.(mp4|mkv)$/ }).first(),
  ).toBeFocused();
  await segmentsToggle.click();
  await expect(segmentsToggle).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Export", exact: true })).toBeVisible();
});

test("panel toggles announce the action for their current state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const mediaToggle = page.getByRole("button", { name: /media library/ }).first();
  const tasksToggle = page.getByRole("button", { name: /editing tools/ }).first();
  await expect(mediaToggle).toHaveAccessibleName("Hide media library");
  await expect(tasksToggle).toHaveAccessibleName("Hide editing tools");
  await mediaToggle.click();
  await expect(mediaToggle).toHaveAttribute("aria-expanded", "false");
  await expect(mediaToggle).toHaveAccessibleName("Show media library");
  await tasksToggle.click();
  await expect(tasksToggle).toHaveAttribute("aria-expanded", "false");
  await expect(tasksToggle).toHaveAccessibleName("Show editing tools");
  await mediaToggle.click();
  await expect(mediaToggle).toHaveAccessibleName("Hide media library");
  await tasksToggle.click();
  await expect(tasksToggle).toHaveAccessibleName("Hide editing tools");
});

test("panel widths persist, desktop sidebars reopen, and narrow drawers stay exclusive", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const mediaToggle = page.getByRole("button", { name: /media library/ }).first();
  const segmentsToggle = page.getByRole("button", { name: /editing tools/ }).first();
  const mediaResizer = page.locator(".media-resizer");
  await mediaResizer.focus();
  await mediaResizer.press("ArrowRight");
  await expect(mediaResizer).toHaveAttribute("aria-valuenow", "256");
  await page.reload();
  await expect(mediaResizer).toHaveAttribute("aria-valuenow", "256");
  await mediaToggle.click();
  await expect(mediaToggle).toHaveAttribute("aria-expanded", "false");
  await segmentsToggle.click();
  await expect(segmentsToggle).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(mediaToggle).toHaveAttribute("aria-expanded", "true");
  await expect(segmentsToggle).toHaveAttribute("aria-expanded", "true");
  await mediaResizer.press("Home");
  await expect(mediaResizer).toHaveAttribute("aria-valuenow", "240");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const closeDrawer = page.getByRole("button", { name: "Close open panel", exact: true });
  await mediaToggle.press("Escape");
  await expect(closeDrawer).toBeHidden();
  await mediaToggle.click();
  await expect(mediaToggle).toHaveAttribute("aria-expanded", "true");
  await expect(segmentsToggle).toHaveAttribute("aria-expanded", "false");
  await closeDrawer.click({ position: { x: 385, y: 2 } });
  await segmentsToggle.click();
  await expect(segmentsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(mediaToggle).toHaveAttribute("aria-expanded", "false");
  await closeDrawer.click({ position: { x: 2, y: 2 } });
  await expect(segmentsToggle).toBeFocused();
});

test("cut labels and per-row split work without invisible menu inputs", async ({ page }) => {
  await chooseMedia(page);
  await setRange(page, 1000, 3000);
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Select cut 1" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByLabel("Label cut 1").fill("Opening");
  await page.getByLabel("Label cut 1").press("Tab");
  await page.getByLabel("Timeline playhead").fill("2000");
  await page.getByRole("button", { name: "Split cut 1 at playhead" }).click();
  await expect(page.getByRole("list", { name: "Selected cuts" }).getByRole("listitem")).toHaveCount(
    2,
  );
  const cutIn = page.getByRole("textbox", { name: "Cut 1 In", exact: true });
  await cutIn.fill("invalid");
  await cutIn.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "valid timecode" })).toBeVisible();
});
