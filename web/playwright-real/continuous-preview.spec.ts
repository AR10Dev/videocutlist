import { expect, test } from "./fixtures";
import { openRealMedia } from "./actions";

test("preview buffers successive windows without reloading or stalling", async ({ page }) => {
  test.setTimeout(90_000);
  await openRealMedia(page);
  const video = page.getByLabel("Preview player");
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  const source = await video.getAttribute("src");
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0.2);
  await video.evaluate((v: HTMLVideoElement) => {
    v.dataset.reloads = "0";
    v.dataset.stalls = "0";
    v.addEventListener("emptied", () => {
      v.dataset.reloads = String(Number(v.dataset.reloads) + 1);
    });
    v.addEventListener("waiting", () => {
      v.dataset.stalls = String(Number(v.dataset.stalls) + 1);
    });
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 60_000 })
    .toBeGreaterThan(45);
  await expect(video).toHaveAttribute("src", source!);
  await expect(video).toHaveAttribute("data-reloads", "0");
  await expect(video).toHaveAttribute("data-stalls", "0");
  await expect(video).toHaveJSProperty("paused", false);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.buffered.end(v.buffered.length - 1)))
    .toBeGreaterThan(50);
  expect(await video.evaluate((v: HTMLVideoElement) => v.buffered.start(0))).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Pause preview", exact: true }).click();
  await expect(video).toHaveJSProperty("paused", true);
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect(video).toHaveJSProperty("paused", false);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 })
    .toBeGreaterThan(52);
  await expect(video).toHaveJSProperty("paused", true);
  await expect(video).toHaveAttribute("data-reloads", "0");
  await expect(video).toHaveAttribute("data-stalls", "0");
});
