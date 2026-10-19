import { expect, test } from "./fixtures";
import { openRealMedia } from "./actions";

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`timeline resolution at ${deviceScaleFactor}x`, () => {
    test.use({ viewport: { width: 2200, height: 1200 }, deviceScaleFactor });

    test("retains thumbnail pixels and requests one waveform sample per display pixel", async ({
      page,
    }) => {
      await page.addInitScript(() => {
        const widths: number[] = [];
        Reflect.set(window, "thumbnailStripWidths", widths);
        const original = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
          if (type === "image/png") widths.push(this.width);
          return original.call(this, callback, type, quality);
        };
      });
      const samples: number[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/waveform"))
          samples.push(Number(url.searchParams.get("samples")));
      });
      await openRealMedia(page);
      const width = await page
        .locator(".timeline-scroll")
        .evaluate((element) => element.clientWidth);
      const pixels = Math.max(16, Math.min(4096, Math.ceil(width * deviceScaleFactor)));
      await expect.poll(() => samples).toContain(pixels);
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, "thumbnailStripWidths") as number[]))
        .toContain(pixels);
    });
  });
}
