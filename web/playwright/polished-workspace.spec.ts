import { expect, test, type Page } from "@playwright/test";
import { CENTER_MIN_WIDTH, WORKSPACE_EDGE_SPACE } from "../src/app/panelPreferences";
import { settingsFixture as settings } from "./fixtures";

const origin = "http://127.0.0.1:8787";
const media = {
  id: `m_${"a".repeat(43)}`,
  name: "camera.mp4",
  durationMs: 10000,
  sizeBytes: 1000,
  container: "mp4",
  etag: "v1",
  streams: {
    tracks: [
      { index: 0, type: "video", codec: "h264" },
      { index: 1, type: "audio", codec: "aac" },
    ],
  },
};
const project = {
  id: "p_polished-project01",
  schemaVersion: 2,
  name: "Saved interview",
  revision: 1,
  updatedAt: "2026-08-20T12:00:00Z",
  items: [
    {
      id: "i_aaaaaaaaaaaaaaaaaaaaaaaa",
      mediaId: media.id,
      segments: [{ startMs: 1000, endMs: 3000, label: "Opening" }],
      exportOptions: { streamIndexes: [] },
    },
  ],
};
async function chooseMedia(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await expect(page.getByRole("button", { name: "Set in", exact: true })).toBeVisible();
}

async function setRange(page: Page, start: number, end: number) {
  const playhead = page.getByLabel("Timeline playhead");
  await playhead.fill(String(start));
  await page.getByRole("button", { name: "Set in" }).click();
  await playhead.fill(String(end));
  await page.getByRole("button", { name: "Set out" }).click();
}

async function openProjectTools(page: Page) {
  const mediaToggle = page.getByRole("button", { name: /media library/ }).first();
  if ((await mediaToggle.getAttribute("aria-expanded")) === "false") await mediaToggle.click();
  await page.getByRole("button", { name: "Project menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Project tools", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Project tools", exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "bearer", token: "test-only-token" },
    };
    Object.defineProperty(window, "MediaSource", { value: undefined });
  });
  await page.route(`${origin}/api/v2/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/media/tree"))
      return route.fulfill({ json: { folders: [], items: [media], nextCursor: null } });
    if (path.endsWith("/media/status"))
      return route.fulfill({ json: { state: "ready_with_media", message: "Library ready." } });
    if (path.endsWith(`/media/${media.id}`)) return route.fulfill({ json: media });
    if (path.endsWith("/projects"))
      return route.fulfill({ json: { items: [project], nextCursor: null } });
    if (path.endsWith("/batches")) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith("/destinations"))
      return route.fulfill({
        json: {
          destinations: settings.settings.destinations,
          capabilities: { saveBesideSource: false },
        },
      });
    if (path.endsWith("/settings")) return route.fulfill({ json: settings });
    if (path.endsWith("/exports/preflight"))
      return route.fulfill({ json: { allowed: true, findings: [], selection: [] } });
    if (/\/projects\/[^/]+$/.test(path)) {
      return route.fulfill({
        json:
          request.method() === "PUT"
            ? {
                ...request.postDataJSON(),
                id: path.split("/").pop(),
                revision: 1,
                updatedAt: "2026-01-01T00:00:00Z",
              }
            : project,
      });
    }
    return route.fulfill({ status: 404 });
  });
});

test.beforeEach(async ({ page }) => {
  await page.route(`${origin}/media/v2/media/${media.id}/thumbnails**`, (route) =>
    route.fulfill({ status: 503 }),
  );
  await page.route(`${origin}/media/v2/media/${media.id}/waveform**`, (route) =>
    route.fulfill({ json: { startMs: 0, durationMs: 10000, peaks: [0.2, 0.8] } }),
  );
});

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
  await expect(page.getByRole("menuitem", { name: "Reset tasks panel size" })).toBeFocused();
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

test("resize-created thumbnail callbacks are released on redraw and unmount", async ({ page }) => {
  await page.goto("/");
  const cleanup = await page.evaluate(async () => {
    const { verifyCanvasImageCleanup } = await import(
      /* @vite-ignore */ new URL("./playwright/timelineCanvasHarness.ts", location.href).href
    );
    return verifyCanvasImageCleanup();
  });
  expect(cleanup).toEqual({ resized: true, releasedPrevious: true, releasedOnDispose: true });
});

for (const width of [390, 600, 700, 1024, 1049, 1050, 1051, 1280, 1440, 1717]) {
  test(`workbench geometry and settings stay usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1005 });
    await page.goto("/");
    await expect(page.locator("main")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await expect(page.getByRole("region", { name: "Media library", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /camera.mp4/ }).click();
    await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Set in", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Set out", exact: true })).toBeVisible();
    if (width >= 1050)
      await expect(
        page.getByText(
          "Set In and Out on the timeline; a valid range becomes one selected segment automatically.",
        ),
      ).toBeVisible();
    await page.getByRole("button", { name: "Add to project" }).click();
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
    await expect(page.getByRole("button", { name: "Play preview" })).toBeDisabled();
  });
}

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

test("missing preview assets and audio remain non-blocking for editing", async ({ page }) => {
  const noAudioMedia = {
    ...media,
    streams: { tracks: [{ index: 0, type: "video", codec: "h264" }] },
  };
  await page.route(`${origin}/api/v2/media/tree`, (route) =>
    route.fulfill({ json: { folders: [], items: [noAudioMedia], nextCursor: null } }),
  );
  await page.route(`${origin}/api/v2/media/${media.id}`, (route) =>
    route.fulfill({ json: noAudioMedia }),
  );
  await chooseMedia(page);
  await expect(
    page.getByRole("status").filter({ hasText: "Thumbnails unavailable" }),
  ).toContainText("Waveform unavailable; editing remains available.");
  await expect(page.getByLabel("Keyframe snapping availability")).toContainText(
    "Keyframe snapping unavailable",
  );
  await expect(page.getByRole("button", { name: "Set in" })).toBeEnabled();

  await setRange(page, 1000, 3000);
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);

  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /Audio:/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create clips" })).toBeEnabled();
});

test("onboarding focuses Media and Export remains reachable with tasks open", async ({ page }) => {
  await page.goto("/");
  const mediaToggle = page.getByRole("button", { name: /media library/ }).first();
  const segmentsToggle = page.getByRole("button", { name: /editing tools/ }).first();
  if ((await mediaToggle.getAttribute("aria-expanded")) === "true") await mediaToggle.click();
  if ((await segmentsToggle.getAttribute("aria-expanded")) === "true") await segmentsToggle.click();
  await page.getByRole("button", { name: "Choose a video" }).click();
  await expect(page.getByRole("button", { name: "Select camera.mp4" })).toBeFocused();
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

test("server projects are browsable without selecting media and support pagination", async ({
  page,
}) => {
  const projectRequests: string[] = [];
  await page.route(`${origin}/api/v2/**`, (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith("/projects")) return route.fallback();
    projectRequests.push(url.href);
    const hasCursor = url.searchParams.has("cursor");
    return route.fulfill({
      json: {
        items: [
          hasCursor ? { ...project, id: "p_second-project01", name: "Second project" } : project,
        ],
        nextCursor: hasCursor ? null : "cursor/page+2",
      },
    });
  });
  await page.goto("/");
  await openProjectTools(page);
  await page.getByText("Browse saved projects", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved interview" })).toBeVisible();
  await expect.poll(() => projectRequests).toHaveLength(1);
  const firstQuery = new URL(projectRequests[0]).searchParams;
  expect(firstQuery.has("cursor")).toBe(false);
  await page.getByRole("button", { name: "Load more projects" }).click();
  await expect(page.getByRole("button", { name: "Second project" })).toBeVisible();
  await expect.poll(() => projectRequests).toHaveLength(2);
  const nextRequest = new URL(projectRequests[1]);
  expect(nextRequest.searchParams.get("cursor")).toBe("cursor/page+2");
  expect(nextRequest.search).toContain("cursor=cursor%2Fpage%2B2");
  await page.getByRole("button", { name: "Saved interview" }).click();
  await expect(page.getByLabel("Project name")).toHaveValue("Saved interview");
  await page.getByRole("button", { name: "Close project tools", exact: true }).click();
  await page.getByRole("tab", { name: "Cuts", exact: true }).click();
  await expect(page.getByLabel("Label cut 1")).toHaveValue("Opening");
});

test("library scans show progress and can be cancelled", async ({ page }) => {
  let cancelled = false;
  let key = "";
  await page.route(`${origin}/api/v2/media/refresh`, (route) => {
    key = route.request().headers()["idempotency-key"] ?? "";
    return route.fulfill({
      status: 202,
      json: { id: "j_scan123456789", state: "running", revision: 1, progress: 0.2, indexed: 2 },
    });
  });
  await page.route(`${origin}/api/v2/jobs/j_scan123456789`, (route) => {
    if (route.request().method() === "DELETE") {
      cancelled = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404 });
  });
  await page.route(`${origin}/api/v2/jobs/j_scan123456789/events`, (route) => {
    const job = {
      id: "j_scan123456789",
      type: "library_scan",
      state: cancelled ? "cancelled" : "running",
      revision: cancelled ? 2 : 1,
      progress: 0.4,
      indexed: 4,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
    };
    return route.fulfill({
      headers: { "content-type": "text/event-stream" },
      body: `id: ${job.revision}\nevent: snapshot\ndata: ${JSON.stringify(job)}\n\n`,
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Refresh media" }).click();
  await expect(page.getByLabel("Library scan")).toContainText("4 indexed");
  expect(key).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Library scan")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh media" })).toBeEnabled();
});

test("detection sends sensitivity settings and rejects invalid values", async ({ page }) => {
  let body: Record<string, unknown> | undefined;
  let detectionProjectId = "";
  await page.route(`${origin}/api/v2/projects/*/detections`, (route) => {
    body = route.request().postDataJSON();
    detectionProjectId = new URL(route.request().url()).pathname.split("/")[4]!;
    expect(body).toMatchObject({ projectRevision: 1 });
    expect(route.request().headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    return route.fulfill({
      status: 202,
      json: {
        id: "j_detect123456789",
        type: "detection",
        state: "queued",
        revision: 1,
        projectRevision: 1,
        mediaId: media.id,
        projectId: detectionProjectId,
        kind: "silence",
      },
    });
  });
  await page.route(`${origin}/api/v2/jobs/j_detect123456789/events`, (route) =>
    route.fulfill({
      headers: { "content-type": "text/event-stream" },
      body: `id: 2\nevent: snapshot\ndata: ${JSON.stringify({
        id: "j_detect123456789",
        type: "detection",
        state: "succeeded",
        revision: 2,
        projectRevision: 1,
        mediaId: media.id,
        projectId: detectionProjectId,
        kind: "silence",
        candidates: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:01Z",
      })}\n\n`,
    }),
  );
  await chooseMedia(page);
  await page.getByRole("button", { name: "Add to project" }).click();
  await page.getByRole("tab", { name: "Auto-detect" }).click();
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByLabel("Silence threshold (dB)").fill("-35");
  await page.getByLabel("Minimum duration (ms)").fill("750");
  await page.getByLabel("Scene threshold").fill("2");
  await page.getByRole("button", { name: "Find pauses" }).click();
  expect(body).toBeUndefined();
  await page.getByLabel("Scene threshold").fill("0.4");
  await page.getByRole("button", { name: "Find pauses" }).click();
  await expect
    .poll(() => body)
    .toMatchObject({ kind: "silence", noiseDb: -35, minDurationMs: 750, sceneThreshold: 0.4 });
});

test("queue exposes every completed output and batch download controls", async ({ page }) => {
  await page.route(`${origin}/api/v2/batches**`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            batchId: "b_outputs12345678",
            state: "succeeded",
            progress: 1,
            jobs: [
              {
                id: "j_output12345678",
                type: "export",
                state: "succeeded",
                revision: 1,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:01Z",
                result: {
                  destinationKind: "download",
                  outputNames: ["first.mkv"],
                  sizeBytes: 10,
                  retainUntil: "2026-01-02T00:00:00Z",
                },
              },
              {
                id: "j_output23456789",
                type: "export",
                state: "succeeded",
                revision: 1,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:01Z",
                result: {
                  destinationKind: "download",
                  outputNames: ["second.mkv"],
                  sizeBytes: 10,
                  retainUntil: "2026-01-02T00:00:00Z",
                },
              },
            ],
          },
          {
            batchId: "b_oldoutputs12345",
            state: "failed",
            progress: 1,
            jobs: [
              {
                id: "j_oldoutputs12345",
                type: "export",
                state: "failed",
                revision: 1,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:01Z",
              },
            ],
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  const queue = page.getByRole("region", { name: "Export queue" });
  await expect(queue.getByRole("button", { name: /Download output/ })).toHaveCount(2);
  await expect(queue.getByText("Completed history (1)", { exact: true })).toBeVisible();
  await expect(queue.locator("details.collapse")).not.toHaveAttribute("open", "");
  await expect(queue.getByRole("button", { name: "Download all clips" })).toBeVisible();
});

test("server-folder completion names the safe destination without download actions", async ({
  page,
}) => {
  await page.route(`${origin}/api/v2/batches**`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            batchId: "b_archive12345678",
            state: "succeeded",
            progress: 1,
            jobs: [
              {
                id: "j_archive12345678",
                type: "export",
                state: "succeeded",
                revision: 1,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:01Z",
                result: {
                  destinationId: "archive",
                  destinationKind: "archive",
                  outputName: "clip.mkv",
                  sizeBytes: 12,
                  retainUntil: "2026-08-21T12:00:00Z",
                },
              },
            ],
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route(`${origin}/api/v2/destinations`, (route) =>
    route.fulfill({
      json: {
        destinations: [
          { id: "archive", label: "Review archive", kind: "archive", retention: "durable" },
        ],
        capabilities: { saveBesideSource: false },
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  const queue = page.getByRole("region", { name: "Export queue" });
  await expect(queue.getByText("Clips created in Review archive.", { exact: true })).toBeVisible();
  await expect(queue.getByRole("button", { name: "Download all clips" })).toHaveCount(0);
  await expect(queue.getByRole("link")).toHaveCount(0);
});

test("server processing inputs are disabled during saves instead of dropping edits", async ({
  page,
}) => {
  let finish: (() => void) | undefined;
  await page.route(`${origin}/api/v2/settings`, async (route) => {
    if (route.request().method() === "PUT") {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return route.fulfill({
        json: { ...settings, revision: 2, settings: { ...settings.settings, exportLimit: 3 } },
      });
    }
    return route.fulfill({ json: settings });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByText("Server processing", { exact: true }).click();
  const concurrency = page.getByLabel("Export concurrency", { exact: true });
  await expect(page.getByLabel("Preview global concurrency")).toHaveAttribute("max", "64");
  await concurrency.fill("3");
  await concurrency.press("Tab");
  await expect(page.getByLabel("Preview global concurrency")).toBeDisabled();
  await expect.poll(() => Boolean(finish)).toBe(true);
  finish!();
  await expect(concurrency).toBeEnabled();
  await expect(concurrency).toHaveValue("3");
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

test("a multi-item JSON cut list restores as a new unsaved project", async ({ page }) => {
  await page.route(`${origin}/api/v2/destinations`, (route) =>
    route.fulfill({
      json: {
        destinations: [
          { id: "download", label: "Downloads", kind: "download", retention: "24h" },
          { id: "archive", label: "Review archive", kind: "archive", retention: "durable" },
        ],
        capabilities: { saveBesideSource: false },
      },
    }),
  );
  await chooseMedia(page);
  await page.getByRole("button", { name: "Add to project" }).click();
  await openProjectTools(page);
  await page.getByText("Interchange", { exact: true }).click();
  page.on("dialog", (dialog) => void dialog.accept());
  const document = {
    ...project,
    items: [project.items[0], { ...project.items[0], id: "i_bbbbbbbbbbbbbbbbbbbbbbbb" }],
  };
  await page.getByLabel("Import cut list", { exact: true }).setInputFiles({
    name: "review.videocutlist.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await expect(page.getByText("Cut list imported. Save the project to keep it.")).toBeVisible();
  await page.getByRole("button", { name: "Close project tools", exact: true }).click();
  const taskToggle = page.getByRole("button", { name: /editing tools/ }).first();
  if ((await taskToggle.getAttribute("aria-expanded")) === "false") await taskToggle.click();
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await page.getByRole("radio", { name: "Selected project items" }).check();
  await expect(page.getByLabel("Project items to export").getByRole("checkbox")).toHaveCount(2);
  const destinations = page.getByLabel("Project items to export").getByLabel(/Destination for/);
  await expect(destinations).toHaveCount(2);
  await destinations.nth(1).selectOption("archive");
  await expect(page.getByLabel("Export plan")).toContainText("2 destinations");
  const saved = page.waitForRequest(
    (request) => request.method() === "PUT" && request.url().includes("/projects/"),
  );
  await page.getByRole("button", { name: "Save project from project header", exact: true }).click();
  expect((await saved).postDataJSON()).toMatchObject({
    revision: 0,
    name: project.name,
    items: [
      document.items[0],
      {
        ...document.items[1],
        exportOptions: { destinationId: "archive" },
      },
    ],
  });
});
