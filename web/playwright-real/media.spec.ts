import type { Project } from "../src/generated/effect-api";
import { expect, test } from "./fixtures";
import { openRealMedia, openTask, addSelectedMediaToProject } from "./actions";

test("decodes real preview media, seeks, pauses, and switches sources", async ({ page }) => {
  const origins = new Set<string>();
  page.on("request", (request) => {
    if (/\/(api|media)\/v2\//.test(new URL(request.url()).pathname))
      origins.add(new URL(request.url()).origin);
  });
  await openRealMedia(page);
  const video = page.getByLabel("Preview player");
  const playhead = page.getByLabel("Timeline playhead");
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0.2);
  expect(
    await video.evaluate((element: HTMLVideoElement) => ({
      width: element.videoWidth,
      error: element.error?.message ?? null,
    })),
  ).toMatchObject({ error: null });
  expect(await video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(
    0,
  );
  await page.getByRole("button", { name: "Pause preview", exact: true }).click();
  await expect(video).toHaveJSProperty("paused", true);
  await playhead.fill("5000");
  await expect(playhead).toHaveValue("5000");
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Mute preview", exact: true }).click();
  await expect(video).toHaveJSProperty("muted", true);
  await page.getByLabel("Preview volume").fill("0.35");
  await expect(video).toHaveJSProperty("volume", 0.35);
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect.poll(async () => Number(await playhead.inputValue())).toBeGreaterThan(5000);
  await page.getByRole("button", { name: "Pause preview", exact: true }).click();
  await page.getByRole("button", { name: "Select sintel-trailer.mkv", exact: true }).click();
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0.2);
  expect([...origins]).toEqual([new URL(page.url()).origin]);
});

test("real silence detection streams candidates, supports review, bulk undo, and scene seeking", async ({
  page,
}) => {
  const streams: string[] = [];
  const calls: string[] = [];
  let submitted: { input: unknown; key: string | undefined } | undefined;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "PUT" && /^\/api\/v2\/projects\/[^/]+$/.test(path)) calls.push("save");
    if (request.method() === "POST" && path.endsWith("/detections")) {
      calls.push("submit");
      submitted = { input: request.postDataJSON(), key: request.headers()["idempotency-key"] };
    }
    if (path.endsWith("/events")) {
      calls.push("observe");
      expect(request.headers().accept).toContain("text/event-stream");
    }
  });
  page.on("response", (response) => {
    if (/\/api\/v2\/jobs\/[^/]+\/events$/.test(new URL(response.url()).pathname))
      streams.push(response.headers()["content-type"] ?? "");
  });
  await openRealMedia(page);
  await addSelectedMediaToProject(page);
  await openTask(page, "Detection");
  const saving = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      /^\/api\/v2\/projects\/[^/]+$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole("button", { name: "Find pauses", exact: true }).click();
  const saved = (await (await saving).json()) as Project;
  const candidates = page.getByLabel("Detection candidates").getByRole("listitem");
  await expect.poll(() => candidates.count(), { timeout: 30000 }).toBeGreaterThan(0);
  expect(streams.some((type) => type.includes("text/event-stream"))).toBe(true);
  expect(calls.slice(0, 3)).toEqual(["save", "submit", "observe"]);
  expect(submitted).toMatchObject({
    key: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/),
    input: {
      kind: "silence",
      projectRevision: saved.revision,
      projectItemId: saved.items[0].id,
      mediaId: saved.items[0].mediaId,
      sourceFingerprint: expect.any(String),
    },
  });
  expect(saved.id).toMatch(/^p_[A-Za-z0-9_-]{12,64}$/);
  expect(saved.items[0].id).toMatch(/^i_[A-Za-z0-9_-]{12,64}$/);
  const count = await candidates.count();
  await expect(
    page.getByRole("status").filter({ hasText: `${count} candidates found.` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Preview candidate 1", exact: true }).click();
  await expect(page.getByLabel("Preview player")).toHaveAttribute(
    "data-playback-mode",
    "active-segment",
  );
  await candidates.first().getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(candidates).toHaveCount(count - 1);
  await page.getByRole("button", { name: "Find pauses", exact: true }).click();
  await expect(candidates).toHaveCount(count);
  await candidates.first().focus();
  await page.keyboard.press("a");
  await expect(candidates).toHaveCount(count - 1);
  if (count > 1) await expect(candidates.first()).toBeFocused();
  await openTask(page, "Export");
  await page.locator(".export-options > summary").click();
  await expect(page.getByLabel("What to export", { exact: true })).toHaveValue("segments");
  await openTask(page, "Cuts");
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(1);
  await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(0);
  await openTask(page, "Detection");
  await page.getByRole("button", { name: "Find pauses", exact: true }).click();
  await expect(candidates).toHaveCount(count);
  await page.getByRole("button", { name: "Accept all valid", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Accept all valid", exact: true })
    .click();
  await openTask(page, "Cuts");
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(count);
  await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(0);
  await openTask(page, "Detection");
  await page.getByRole("button", { name: "Find scene changes", exact: true }).click();
  await expect.poll(() => candidates.count(), { timeout: 30000 }).toBeGreaterThan(0);
  await expect(
    candidates.first().getByRole("button", { name: "Add segment", exact: true }),
  ).toHaveCount(0);
  await candidates.first().getByRole("button", { name: "Seek to point", exact: true }).click();
  expect(Number(await page.getByLabel("Timeline playhead").inputValue())).toBeGreaterThan(0);
  await candidates
    .first()
    .getByRole("button", { name: "Preview candidate 1", exact: true })
    .click();
  expect(Number(await page.getByLabel("Timeline playhead").inputValue())).toBeGreaterThan(0);
  const sceneCount = await candidates.count();
  await candidates.first().getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(candidates).toHaveCount(sceneCount - 1);
});
