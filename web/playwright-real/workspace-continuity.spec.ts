import { copyFile, link, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { openRealMedia, openTask } from "./actions";

test("settings restores the open task and preserves intentionally closed tasks", async ({
  page,
}) => {
  await openRealMedia(page);
  await openTask(page, "Export");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to editor", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Export", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Export", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: /Hide editing tools/ }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to editor", exact: true }).click();
  await expect(page.locator("#segments-panel")).not.toBeVisible();
});

test("settings retains the live video and advances playback while hidden", async ({ page }) => {
  await openRealMedia(page);
  const video = page.getByLabel("Preview player");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0.2);
  const element = await video.elementHandle();
  const before = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect
    .poll(() => element!.evaluate((v: HTMLVideoElement) => v.isConnected && !v.paused))
    .toBe(true);
  await expect
    .poll(() => element!.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(before + 1);
  await page.getByRole("button", { name: "Back to editor", exact: true }).click();
  expect(
    await element!.evaluate((v: HTMLVideoElement) => v === document.querySelector("video")),
  ).toBe(true);
  await expect(video).toHaveJSProperty("paused", false);
  await expect(
    page.getByText(
      "Keyframe snapping unavailable; authoritative source timestamps are not exposed.",
      { exact: true },
    ),
  ).toHaveCount(0);
});

test("All media and real nested folders collapse without interrupting playback", async ({
  page,
  app,
}) => {
  await mkdir(join(app.mediaRoot, "Shows", "Season 1"), { recursive: true });
  await copyFile(
    join(app.mediaRoot, "sintel-trailer.mp4"),
    join(app.mediaRoot, "Shows", "episode.mp4"),
  );
  await copyFile(
    join(app.mediaRoot, "sintel-trailer.mp4"),
    join(app.mediaRoot, "Shows", "Season 1", "pilot.mp4"),
  );
  await openRealMedia(page);
  await page.getByRole("button", { name: "Refresh media", exact: true }).click();
  const root = page.getByRole("button", { name: "All media", exact: true });
  await expect(root).toHaveAttribute("aria-expanded", "true");
  await root.click();
  await expect(root).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("button", { name: "Select sintel-trailer.mp4", exact: true }),
  ).not.toBeVisible();
  await root.click();
  const shows = page.getByRole("button", { name: "Shows", exact: true });
  await shows.click();
  await expect(shows).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Select episode.mp4", exact: true })).toBeVisible();
  const season = page.getByRole("button", { name: "Season 1", exact: true });
  await season.click();
  await expect(page.getByRole("button", { name: "Select pilot.mp4", exact: true })).toBeVisible();
  const video = page.getByLabel("Preview player");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await shows.click();
  await expect(shows).toHaveAttribute("aria-expanded", "false");
  await expect(season).not.toBeVisible();
  await shows.click();
  await expect(season).toBeVisible();
  await expect(video).toHaveJSProperty("paused", false);
});

test("expanded folders load subsequent real media pages", async ({ page, app }) => {
  await mkdir(join(app.mediaRoot, "Pages"));
  await Promise.all(
    Array.from({ length: 52 }, (_, index) =>
      link(
        join(app.mediaRoot, "sintel-trailer.mp4"),
        join(app.mediaRoot, "Pages", `clip-${index}.mp4`),
      ),
    ),
  );
  await page.goto("/");
  const refresh = page.getByRole("button", { name: "Refresh media", exact: true });
  await refresh.click();
  const folder = page.getByRole("button", { name: "Pages", exact: true });
  await expect(folder).toBeVisible({ timeout: 60_000 });
  await expect(refresh).toBeEnabled({ timeout: 60_000 });
  await folder.click();
  const clips = page.getByRole("button", { name: /^Select clip-/ });
  await expect(clips).toHaveCount(50);
  await page.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(clips).toHaveCount(52);
  await folder.click();
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await expect(clips).toHaveCount(0);
});
