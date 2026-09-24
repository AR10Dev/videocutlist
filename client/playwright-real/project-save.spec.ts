import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import type { components } from "../src/generated/api";

const token = "real-media-test-token";
const serverBaseUrl = "http://127.0.0.1:18787";
const run = promisify(execFile);

async function addSegment(page: Page, startMs: number, endMs: number, startNew = false) {
  if (startNew) {
    await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
    await page.keyboard.press("c");
  }
  const playhead = page.getByLabel("Timeline playhead");
  await playhead.fill(String(startMs));
  await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
  await page.keyboard.press("i");
  await playhead.fill(String(endMs));
  await page.getByRole("heading", { name: "Timeline", exact: true }).focus();
  await page.keyboard.press("o");
}

async function addMediaWithSegments(page: Page, name: string) {
  await page.getByRole("button", { name: `Select ${name}` }).click();
  await page.getByRole("button", { name: "Add to project" }).click();
  await addSegment(page, 1_000, 3_000);
  await addSegment(page, 4_000, 6_000, true);
}

async function openExport(page: Page) {
  const taskToggle = page.getByRole("button", { name: /editing tools/ }).first();
  if ((await taskToggle.getAttribute("aria-expanded")) === "false") await taskToggle.click();
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create clips" })).toBeVisible();
}

async function createClips(page: Page, jobCount: number) {
  const create = page.getByRole("button", { name: "Create clips" });
  await expect(create).toBeEnabled();
  await create.click();
  const batch = page.getByRole("region", { name: "Current batch" });
  await expect(batch.getByText("succeeded", { exact: true })).toHaveCount(jobCount, {
    timeout: 120_000,
  });
  return batch;
}

async function downloadAndProbe(page: Page, link: Locator, testInfo: TestInfo, filename: string) {
  const downloadPromise = page.waitForEvent("download");
  await link.click();
  const download = await downloadPromise;
  const path = testInfo.outputPath(filename);
  await download.saveAs(path);
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,format_name",
    "-of",
    "json",
    path,
  ]);
  const probe = JSON.parse(stdout) as { format?: { duration?: string; format_name?: string } };
  expect(Number(probe.format?.duration)).toBeGreaterThan(0);
  expect(probe.format?.format_name).toBeTruthy();
}

async function downloadBatch(page: Page, batch: Locator, testInfo: TestInfo) {
  const downloadPromise = page.waitForEvent("download");
  await batch.getByRole("button", { name: "Download all clips" }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("videocutlist-clips.zip");
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const archive = await readFile(path);
  expect(archive.length).toBeGreaterThan(1_000);
  expect(archive.subarray(0, 2).toString()).toBe("PK");
}

test("creates, downloads, and verifies every export option with real media", async ({
  page,
  request,
}, testInfo) => {
  await page.addInitScript(
    ({ baseUrl, bearerToken }) => {
      window.VIDEOCUTLIST_CONFIG = {
        serverBaseUrl: baseUrl,
        authentication: { type: "bearer", token: bearerToken },
      };
    },
    { baseUrl: serverBaseUrl, bearerToken: token },
  );
  await page.goto("/");
  await addMediaWithSegments(page, "sintel-trailer.mp4");
  await addMediaWithSegments(page, "sintel-trailer.mkv");
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(2);

  let saveRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      /\/api\/v1\/projects\/[^/]+$/.test(new URL(request.url()).pathname)
    )
      saveRequests += 1;
  });
  await page.locator(".project-menu > summary").click();
  await page.getByRole("button", { name: "Project tools" }).click();
  const projectName = page.getByLabel("Project name");
  await projectName.fill(" ");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("alert").getByText("Project name is required.")).toBeVisible();
  expect(saveRequests).toBe(0);
  await projectName.fill("Real media exports");

  const savedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      /\/api\/v1\/projects\/[^/]+$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const response = await savedResponse;
  expect(response.status()).toBe(200);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const saved = (await response.json()) as components["schemas"]["Project"];
  expect(saved.items).toHaveLength(2);

  await page.getByRole("button", { name: "Close project tools", exact: true }).click();
  await openExport(page);

  // Selected/all items, separate cuts, automatic tracks, fast copy, MP4, naming, destination.
  await page.getByRole("radio", { name: "Selected project items" }).check();
  await page.getByRole("button", { name: "Select none" }).click();
  await expect(page.getByRole("button", { name: "Create clips" })).toBeDisabled();
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByLabel("Output arrangement").selectOption("separate");
  await page.getByLabel("Output container").selectOption("mp4");
  await page.getByLabel("What to export").selectOption("segments");
  await page.getByLabel("Processing").selectOption("stream_copy_preferred");
  await page.getByLabel("Destination", { exact: true }).selectOption("download");
  await page.getByText("Advanced naming", { exact: true }).click();
  await page.getByLabel("Filename template").fill("ui-{source}-{segment}.{ext}");
  await expect(page.getByText("Automatic", { exact: true })).toBeVisible();
  const separateBatch = await createClips(page, 2);
  await expect(separateBatch).toContainText("One output per cut");
  await expect(separateBatch).toContainText("Included cuts");
  await expect(separateBatch).toContainText("MP4");
  await expect(separateBatch).toContainText("Stream copy preferred");
  await expect(separateBatch).toContainText("Browser download");
  await expect(
    separateBatch.locator(".export-output-list code").filter({ hasText: "ui-" }),
  ).toHaveCount(2);
  await expect(separateBatch.getByRole("link", { name: /Download output/ })).toHaveCount(4);
  await downloadAndProbe(
    page,
    separateBatch.getByRole("link", { name: "Download output 1" }).first(),
    testInfo,
    "separate-fast-copy.mp4",
  );
  await downloadBatch(page, separateBatch, testInfo);

  // Active item, merged gaps, explicit tracks, precise encode, MOV.
  await page.getByRole("button", { name: "Select sintel-trailer.mp4" }).click();
  await page.getByRole("radio", { name: "Active media item" }).check();
  await page.getByLabel("Output arrangement").selectOption("merge");
  await page.getByLabel("Output container").selectOption("mov");
  await page.getByLabel("What to export").selectOption("gaps");
  await page.getByLabel("Processing").selectOption("precise_reencode");
  const audio = page.getByRole("checkbox", { name: "Audio: aac" });
  await audio.uncheck();
  await audio.check();
  await expect(page.getByText("Explicit streams: 0, 1.", { exact: true })).toBeVisible();
  const preciseBatch = await createClips(page, 1);
  await expect(preciseBatch).toContainText("One merged output");
  await expect(preciseBatch).toContainText("Gaps between cuts");
  await expect(preciseBatch).toContainText("MOV");
  await expect(preciseBatch).toContainText("Precise re-encode");
  await downloadAndProbe(
    page,
    preciseBatch.getByRole("link", { name: "Download output 1" }),
    testInfo,
    "merged-gaps-precise.mov",
  );
  await page.getByRole("button", { name: "Reset to automatic tracks" }).click();

  // Hybrid smart cut is available for the remuxed real H.264 CFR MKV source.
  await page.getByRole("button", { name: "Select sintel-trailer.mkv" }).click();
  await page.getByLabel("Output container").selectOption("mkv");
  await page.getByLabel("What to export").selectOption("segments");
  await page.getByLabel("Processing").selectOption("hybrid_smart_cut");
  const hybridBatch = await createClips(page, 1);
  await expect(hybridBatch).toContainText("Hybrid smart cut");
  await expect(hybridBatch).toContainText("MKV");
  await downloadAndProbe(
    page,
    hybridBatch.getByRole("link", { name: "Download output 1" }),
    testInfo,
    "hybrid-smart-cut.mkv",
  );

  const persistedResponse = await request.get(`/api/v1/projects/${saved.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(persistedResponse.status()).toBe(200);
  const persisted = (await persistedResponse.json()) as components["schemas"]["Project"];
  expect(persisted.items).toHaveLength(2);
  expect(persisted.items.every((item) => item.segments.length === 2)).toBe(true);
});
