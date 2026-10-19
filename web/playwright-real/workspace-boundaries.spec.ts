import { expect, test } from "./fixtures";

test("workspace uses project controls on the left and keeps tasks focused", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".workspace-action-row")).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Project status" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save project from project header" }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Cuts", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Auto-detect", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Export", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Project", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Export queue" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Export queue" })).toBeVisible();
});

test("restored panel widths survive initialization and settings keeps its trigger reachable", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "videocutlist.workspace-panels.v1",
      JSON.stringify({
        mediaWidth: 280,
        segmentsWidth: 340,
        mediaCollapsed: true,
        segmentsCollapsed: true,
      }),
    ),
  );
  await page.goto("/");
  const shell = page.locator("main.app-shell");
  await expect
    .poll(() =>
      shell.evaluate((element) => [
        getComputedStyle(element).getPropertyValue("--media-panel-width"),
        getComputedStyle(element).getPropertyValue("--segments-panel-width"),
      ]),
    )
    .toEqual(["280px", "340px"]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem("videocutlist.workspace-panels.v1") ?? "null"),
      ),
    )
    .toMatchObject({
      mediaWidth: 280,
      segmentsWidth: 340,
      mediaCollapsed: false,
      segmentsCollapsed: false,
    });
  await page.getByRole("button", { name: "Settings" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = JSON.parse(
          localStorage.getItem("videocutlist.workspace-panels.v1") ?? "null",
        );
        return stored?.mediaCollapsed;
      }),
    )
    .toBe(false);
  await page.reload();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
});

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

test("editor shortcuts filter DOM targets and modifiers and reattach exactly once", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select sintel-trailer.mp4" }).click();
  const playhead = page.getByLabel("Timeline playhead");
  await playhead.fill("1000");
  await page.evaluate(() => {
    const dispatch = (target: Element, init: KeyboardEventInit, handled = false) => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowRight",
        ...init,
      });
      if (handled) event.preventDefault();
      target.dispatchEvent(event);
    };
    dispatch(document.body, {}, true);
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"])
      dispatch(document.body, { [modifier]: true });
    for (const role of ["menu", "dialog", "combobox"]) {
      const target = document.createElement("div");
      target.setAttribute("role", role);
      document.body.append(target);
      dispatch(target, {});
      target.remove();
    }
    const input = document.createElement("input");
    document.body.append(input);
    dispatch(input, {});
    input.remove();
  });
  await expect(playhead).toHaveValue("1000");
  for (let index = 0; index < 3; index++) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator("body").press("ArrowRight");
    await page.getByRole("button", { name: "Back to editor" }).click();
  }
  await expect(playhead).toHaveValue("1000");
  await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(playhead).toHaveValue("2000");
});

for (const width of [390, 1049, 1050, 1051, 1717]) {
  test(`workbench geometry and settings stay usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1005 });
    await page.goto("/");
    await expect(page.locator("main")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await expect(page.getByRole("region", { name: "Media library", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Select sintel-trailer.mp4", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Set in", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Set out", exact: true })).toBeVisible();
    if (width >= 1050)
      await expect(
        page.getByText(
          "Set In and Out on the timeline; a valid range becomes one selected segment automatically.",
        ),
      ).toBeVisible();
    await expect(page.getByRole("button", { name: "Add to project" })).toHaveCount(0);
    const editorHeader = await page.locator(".editor-heading").boundingBox();
    expect(editorHeader!.y).toBeLessThanOrEqual(20);
    expect(editorHeader!.height).toBeLessThan(100);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    const timeline = await page
      .locator(".timeline-scroll")
      .evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(timeline.scroll).toBeLessThanOrEqual(timeline.width + 1);
    const tabs = await page.getByRole("tab").all();
    for (let i = 1; i < tabs.length; i++) {
      const previous = (await tabs[i - 1].boundingBox())!;
      const current = (await tabs[i].boundingBox())!;
      expect(current.x).toBeGreaterThanOrEqual(previous.x + previous.width - 1);
    }
    if (width >= 1051) {
      const timelineBox = (await page.locator(".timeline-scroll").boundingBox())!;
      expect(timelineBox.y + timelineBox.height).toBeLessThan(1005);
    }
    if (width < 1050) {
      const mediaToggle = page.getByRole("button", { name: /media library/ }).first();
      const segmentsToggle = page.getByRole("button", { name: /editing tools/ }).first();
      if ((await mediaToggle.getAttribute("aria-expanded")) === "true") await mediaToggle.click();
      if ((await segmentsToggle.getAttribute("aria-expanded")) === "false")
        await segmentsToggle.click();
    }
    await page.getByRole("tab", { name: "Export", exact: true }).click();
    // Export options are intentionally expanded by default.
    await expect(page.getByLabel("Output arrangement", { exact: true })).toBeVisible();
    const track = page.getByRole("checkbox", { name: "Audio: aac" });
    const trackBox = (await track.boundingBox())!;
    expect(trackBox.width).toBeLessThanOrEqual(24);
    expect(trackBox.width).toBeCloseTo(trackBox.height, 0);
    await track.uncheck();
    await expect(track).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Video: h264" })).toBeDisabled();
    if (width < 1050) {
      await page.getByRole("tab", { name: "Export", exact: true }).press("Escape");
    }
    const settingsPanelToggle = page.getByRole("button", { name: /media library/ }).first();
    if ((await settingsPanelToggle.getAttribute("aria-expanded")) === "false")
      await settingsPanelToggle.click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const mute = page.getByRole("checkbox", { name: "Mute previews" });
    const muteBox = (await mute.boundingBox())!;
    expect(muteBox.width).toBeLessThanOrEqual(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.getByRole("button", { name: "Back to editor" }).click();
    await expect(page.getByRole("button", { name: "Play preview" })).toBeEnabled();
  });
}
