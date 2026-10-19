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
