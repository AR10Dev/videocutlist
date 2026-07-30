import { expect, test } from "@playwright/test";

const media = {
  id: "m_0123456789012345678901234567890123456789012",
  name: "camera.mp4",
  durationMs: 10_000,
  sizeBytes: 1000,
  container: "mp4",
  streams: {},
  etag: "v1",
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class FakeBuffer extends EventTarget {
      updating = false;
      appendBuffer() {
        this.updating = true;
        queueMicrotask(() => {
          this.updating = false;
          this.dispatchEvent(new Event("updateend"));
        });
      }
    }
    class FakeMediaSource extends EventTarget {
      static isTypeSupported() {
        return true;
      }
      readyState = "open";
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("sourceopen")));
      }
      addSourceBuffer() {
        return new FakeBuffer();
      }
      endOfStream() {}
    }
    Object.defineProperty(window, "MediaSource", { value: FakeMediaSource });
    Object.defineProperty(URL, "createObjectURL", {
      value: () => "blob:preview",
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined });
  });
  let savedRevision = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/media")
      return route.fulfill({ json: { items: [media] } });
    if (url.pathname === `/api/v1/media/${media.id}`)
      return route.fulfill({ json: media });
    if (url.pathname.includes("/preview")) {
      const center = url.searchParams.get("centerMs") ?? "0";
      if (center === "1000")
        await new Promise((resolve) => setTimeout(resolve, 100));
      return route.fulfill({
        headers: {
          "content-type": "video/mp4",
          "X-Preview-Start": "0",
          "X-Preview-Duration": "8000",
          "X-Preview-Offset": center,
          "X-Preview-Cache": "hit",
          "X-Request-ID": `preview-${center}`,
        },
        body: "fragment",
      });
    }
    if (request.method() === "GET")
      return route.fulfill({
        json: {
          id: "p_demo-project",
          mediaId: media.id,
          revision: 4,
          segments: [{ startMs: 100, endMs: 700, label: "restored" }],
          uiState: { playheadMs: 700, zoom: 1, muted: false },
        },
      });
    if (request.method() === "PUT") {
      if (url.pathname.endsWith("p_conflict"))
        return route.fulfill({
          status: 409,
          json: {
            error: { code: "conflict", message: "stale", requestId: "r" },
          },
        });
      savedRevision += 1;
      return route.fulfill({
        json: {
          id: "p_demo-project",
          mediaId: media.id,
          revision: savedRevision,
          segments: [],
          uiState: { playheadMs: 0, zoom: 1, muted: false },
        },
      });
    }
    return route.fulfill({ status: 404 });
  });
});

test("MVP browser behavior: list, metadata, settle, cancel, offset, markers, restore, and stale protection", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /camera.mp4/ })).toBeVisible(); // 1 media list loads
  await page.getByRole("button", { name: /camera.mp4/ }).click();

  const playhead = page.getByLabel("Timeline playhead");
  await expect(playhead).toHaveAttribute("max", "10000"); // 2 metadata loads
  await playhead.fill("1000");
  await expect(page.getByText("Loading preview…")).not.toBeVisible();
  await page.waitForTimeout(220);
  await expect(page.getByText("Loading preview…")).toBeVisible(); // 3 request waits for the 200 ms settle debounce
  await playhead.fill("2000");
  await expect(page.getByText("Preview ready.")).toBeVisible(); // 4 stale request is cancelled/ignored; 5 preview begins
  await expect(page.getByLabel("Preview player")).toHaveAttribute(
    "data-preview-offset",
    "2000",
  ); // 6 returned offset is used
  await expect(page.getByText("preview-2000")).toBeVisible(); // 9 rapid reselection never presents the stale response

  await playhead.fill("100");
  await page.keyboard.press("i");
  await playhead.fill("700");
  await page.keyboard.press("o");
  await expect(page.getByText("preview-700")).toBeVisible(); // wait for the final marker preview before saving
  await page.getByRole("button", { name: "Add In/Out segment" }).click();
  await expect(page.getByText("0:00 – 0:01")).toBeVisible();
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText(/Project saved/)).toBeVisible(); // 7 markers save

  await page.getByRole("button", { name: "Load project" }).click();
  await expect(page.getByText("Project loaded.")).toBeVisible(); // 8 project restores after reload
  await expect(page.getByText(/restored/)).toBeVisible();
});

test("save reports an optimistic revision conflict", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /camera.mp4/ }).click();
  await page.getByLabel("Project ID").fill("p_conflict");
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByText(/Load latest before saving/)).toBeVisible();
});
