import { expect } from "@playwright/test";
import { test } from "./fixtures";
import { openRealMedia as openMedia, saveProject, openTask, newProject, setRange } from "./actions";

test("browser export defaults never silently change a saved project's options", async ({
  page,
}) => {
  let savedOptions: { cutStrategy?: string; filenameTemplate?: string } | undefined;
  page.on("request", (request) => {
    if (
      request.method() !== "PUT" ||
      !/\/api\/v2\/projects\/[^/]+$/.test(new URL(request.url()).pathname)
    )
      return;
    const body = request.postDataJSON() as {
      items: Array<{ exportOptions: { cutStrategy?: string; filenameTemplate?: string } }>;
    };
    savedOptions = body.items[0].exportOptions;
  });
  await openMedia(page);
  await setRange(page, 100, 700);
  await saveProject(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Cut strategy").selectOption("precise_reencode");
  await page
    .getByRole("textbox", { name: "Filename template", exact: true })
    .fill("future-{segment}.{ext}");
  await page.getByRole("checkbox", { name: "Mute previews" }).check();
  await page.getByRole("button", { name: "Back to editor" }).click();
  await expect(page.getByRole("status", { name: "Project status" })).toHaveText("Saved");
  await expect(page.getByRole("button", { name: "Mute preview", exact: true })).toBeVisible();
  await openTask(page, "Export");
  await expect(page.getByLabel("Processing")).toHaveValue("stream_copy_preferred");
  await expect(page.getByLabel("Filename template")).toHaveValue("{source}-{segment}.{ext}");
  savedOptions = undefined;
  await page.getByRole("button", { name: "Save project from project header", exact: true }).click();
  await expect
    .poll(() => savedOptions)
    .toMatchObject({
      cutStrategy: "stream_copy_preferred",
      filenameTemplate: "{source}-{segment}.{ext}",
    });
  await page.getByRole("button", { name: "Select sintel-trailer.mkv" }).click();
  await expect(page.getByRole("button", { name: "Unmute preview", exact: true })).toBeVisible();
  await openTask(page, "Export");
  await expect(page.getByLabel("Processing")).toHaveValue("precise_reencode");
  await expect(page.getByLabel("Filename template")).toHaveValue("future-{segment}.{ext}");
  await openTask(page, "Export");
  await page.locator(".export-options > summary").click();
  await page.getByText("Advanced naming", { exact: true }).click();
  await page.getByLabel("Filename template").fill("é".repeat(80));
  await expect(page.getByLabel("Filename template")).toHaveValue("é".repeat(80));
  await page.getByLabel("Filename template").fill("é".repeat(81));
  await expect(page.getByLabel("Filename template")).toHaveValue("é".repeat(80));
});

test("unavailable browser storage still permits settings reset and new project", async ({
  page,
}) => {
  await page.addInitScript(() => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      Object.defineProperty(Storage.prototype, method, {
        configurable: true,
        value: () => {
          throw new DOMException("Blocked", "SecurityError");
        },
      });
    }
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Filename template").fill("clip-{segment}.{ext}");
  await page.getByLabel("Filename template").fill("x".repeat(161));
  await expect(page.getByLabel("Filename template")).toHaveValue("x".repeat(160));
  await page.getByRole("button", { name: "Reset browser preferences" }).click();
  await expect(page.getByLabel("Filename template")).toHaveValue("{source}-{segment}.{ext}");
  await page.getByRole("button", { name: "Back to editor" }).click();
  await newProject(page);
  await expect(page.getByRole("status", { name: "Project status" })).toContainText("Not saved yet");
  expect(errors).toEqual([]);
});

test("keeps motion reduced and overflow local at a narrow viewport", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await openMedia(page);

  await expect(page.getByRole("button", { name: "Play preview" })).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await setRange(page, 100, 700);
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);
  await expect(page.locator(".cut-menu")).not.toHaveAttribute("open");
  await page.locator(".cut-menu summary").click();
  await expect(page.getByRole("button", { name: "Remove cut 1" })).toBeVisible();
  await expect(page.getByLabel("Label cut 1")).toBeVisible();
  const closeTasks = page.getByRole("button", { name: "Close segments panel" });
  if (await closeTasks.isVisible()) await closeTasks.click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const timelineOverflow = await page.locator(".timeline-scroll").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(timelineOverflow.scroll).toBeLessThanOrEqual(timelineOverflow.client + 1);
  await page.evaluate(() =>
    globalThis.dispatchEvent(new CustomEvent("timeline-zoom", { detail: 2 })),
  );
  await expect
    .poll(() =>
      page
        .locator(".timeline-scroll")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    )
    .toBe(true);
});
