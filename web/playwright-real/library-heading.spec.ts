import { expect, test } from "./fixtures";
import { openRealMedia } from "./actions";

test("aligns All media and refresh on one row before and after selection", async ({ page }) => {
  await page.goto("/");
  const library = page.getByRole("region", { name: "Media library", exact: true });
  const allMedia = library.getByRole("button", { name: "All media", exact: true });
  const refresh = library.getByRole("button", { name: "Refresh media", exact: true });
  const checkAlignment = async () => {
    await expect(allMedia).toBeVisible();
    await expect(refresh).toBeVisible();
    const folder = (await allMedia.boundingBox())!;
    const reload = (await refresh.boundingBox())!;
    expect(Math.abs(folder.y + folder.height / 2 - reload.y - reload.height / 2)).toBeLessThan(1);
    expect(folder.x + folder.width).toBeLessThanOrEqual(reload.x);
  };
  await checkAlignment();
  await openRealMedia(page);
  await checkAlignment();
  await allMedia.click();
  await expect(allMedia).toHaveAttribute("aria-expanded", "false");
  await allMedia.click();
  await expect(
    page.getByRole("button", { name: "Select sintel-trailer.mp4", exact: true }),
  ).toBeVisible();
});
