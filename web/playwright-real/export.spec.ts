import type * as EffectApiTypes from "../src/generated/effect-api";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./fixtures";
import { addMediaWithSegments, addSegment, saveProject } from "./actions";
const run = promisify(execFile);

async function openExport(page: Page) {
  const taskToggle = page.getByRole("button", { name: /editing tools/ }).first();
  if ((await taskToggle.getAttribute("aria-expanded")) === "false") await taskToggle.click();
  await page.getByRole("tab", { name: "Export", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create clips" })).toBeVisible();
}

async function createClips(page: Page, jobCount: number) {
  const create = page.getByRole("button", { name: "Create clips" });
  await expect(create).toBeEnabled();
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/v2\/projects\/[^/]+\/exports$/.test(new URL(response.url()).pathname),
  );
  await create.click();
  const response = await submitted;
  expect(response.status()).toBe(202);
  const submission = (await response.json()) as EffectApiTypes.BatchExportSubmission;
  const batch = page.getByRole("region", { name: "Current batch" });
  for (const job of submission.jobs)
    await expect(batch.getByText(job.id, { exact: true })).toBeVisible();
  await expect(batch.getByText("succeeded", { exact: true })).toHaveCount(jobCount, {
    timeout: 120_000,
  });
  return batch;
}

async function downloadAndProbe(
  page: Page,
  button: Locator,
  testInfo: TestInfo,
  filename: string,
  expected: { format: RegExp; durationSeconds: number; toleranceSeconds: number; audio: boolean },
) {
  const downloadPromise = page.waitForEvent("download");
  await button.click();
  const download = await downloadPromise;
  const path = testInfo.outputPath(filename);
  await download.saveAs(path);
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,format_name:stream=codec_type,codec_name",
    "-of",
    "json",
    path,
  ]);
  const probe = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: { codec_type: string; codec_name: string }[];
  };
  const duration = Number(probe.format?.duration);
  expect(duration).toBeGreaterThan(0);
  expect(Math.abs(duration - expected.durationSeconds)).toBeLessThanOrEqual(
    expected.toleranceSeconds,
  );
  expect(probe.format?.format_name).toMatch(expected.format);
  expect(probe.streams?.find((stream) => stream.codec_type === "video")?.codec_name).toBe("h264");
  if (expected.audio)
    expect(probe.streams?.find((stream) => stream.codec_type === "audio")?.codec_name).toBe("aac");
  expect(probe.streams?.map((stream) => stream.codec_type).sort()).toEqual(
    expected.audio ? ["audio", "video"] : ["video"],
  );
}

function zipEntryNames(archive: Buffer): string[] {
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(endOffset).toBeGreaterThanOrEqual(0);
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  expect(entriesOnDisk).toBe(entryCount);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const centralEnd = centralOffset + centralSize;
  expect(centralEnd).toBeLessThanOrEqual(endOffset);

  const names: string[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    names.push(archive.toString("utf8", offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  expect(offset).toBe(centralEnd);
  return names;
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
  const entries = zipEntryNames(archive);
  const expectedNames = await batch.locator(".export-output-list code").allTextContents();
  expect(entries).toHaveLength(4);
  expect(expectedNames).toHaveLength(4);
  expect([...entries].sort()).toEqual([...expectedNames].sort());
}

test("creates, downloads, and verifies selected real-media export scenarios", async ({
  page,
  request,
  app,
}, testInfo) => {
  await page.goto("/");
  await addMediaWithSegments(page, "sintel-trailer.mp4");
  await addMediaWithSegments(page, "sintel-trailer.mkv");
  await expect(page.locator(".cut-row[data-segment-id]")).toHaveCount(2);

  let saveRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      /\/api\/v2\/projects\/[^/]+$/.test(new URL(request.url()).pathname)
    )
      saveRequests += 1;
  });
  await page.getByRole("button", { name: "Project menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Project tools", exact: true }).click();
  const projectName = page.getByLabel("Project name");
  await projectName.fill(" ");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Project tools" }).getByRole("status")).toHaveText(
    "Project name is required.",
  );
  expect(saveRequests).toBe(0);
  await projectName.fill("Real media exports");

  const savedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      /\/api\/v2\/projects\/[^/]+$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const response = await savedResponse;
  expect(response.status()).toBe(200);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const saved = (await response.json()) as EffectApiTypes.Project;
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
  await expect(separateBatch.getByRole("button", { name: /Download output/ })).toHaveCount(4);
  await downloadAndProbe(
    page,
    separateBatch.getByRole("button", { name: "Download output 1" }).first(),
    testInfo,
    "separate-fast-copy.mp4",
    { format: /mp4/, durationSeconds: 2, toleranceSeconds: 1.5, audio: true },
  );
  await downloadBatch(page, separateBatch, testInfo);

  const persistedResponse = await request.get(`/api/v2/projects/${saved.id}`, {
    headers: { Authorization: `Bearer ${app.token}` },
  });
  expect(persistedResponse.status()).toBe(200);
  const persisted = (await persistedResponse.json()) as EffectApiTypes.Project;
  expect(persisted.items).toHaveLength(2);
  expect(persisted.items.every((item) => item.segments.length === 2)).toBe(true);
});

test("downloads merged MOV gaps with explicit tracks and precise encoding", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await addMediaWithSegments(page, "sintel-trailer.mp4");
  await saveProject(page);
  await openExport(page);
  await page.getByLabel("Output arrangement").selectOption("merge");
  await page.getByLabel("Output container").selectOption("mov");
  const gapDuration =
    Number(await page.getByLabel("Timeline playhead").getAttribute("max")) / 1000 - 4;
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
    preciseBatch.getByRole("button", { name: "Download output 1" }),
    testInfo,
    "merged-gaps-precise.mov",
    { format: /mov/, durationSeconds: gapDuration, toleranceSeconds: 0.15, audio: true },
  );
  await audio.uncheck();
  const videoOnlyBatch = await createClips(page, 1);
  await downloadAndProbe(
    page,
    videoOnlyBatch.getByRole("button", { name: "Download output 1" }),
    testInfo,
    "video-only-gaps.mov",
    { format: /mov/, durationSeconds: gapDuration, toleranceSeconds: 0.15, audio: false },
  );
  await page.getByRole("button", { name: "Reset to automatic tracks" }).click();
});

test("downloads a probed merged MKV using hybrid smart cut", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select sintel-trailer.mkv", exact: true }).click();
  // Hybrid processing needs interior keyframes, not two-second copy-fallback spans.
  await addSegment(page, 1_000, 11_000);
  await addSegment(page, 13_000, 23_000, true);
  await saveProject(page);
  await openExport(page);
  await page.getByLabel("Output arrangement").selectOption("merge");
  await page.getByLabel("Output container").selectOption("mkv");
  await page.getByLabel("What to export").selectOption("segments");
  await page.getByLabel("Processing").selectOption("hybrid_smart_cut");
  const hybridBatch = await createClips(page, 1);
  await expect(hybridBatch).toContainText("Hybrid smart cut");
  await expect(hybridBatch).toContainText("MKV");
  await downloadAndProbe(
    page,
    hybridBatch.getByRole("button", { name: "Download output 1" }),
    testInfo,
    "hybrid-smart-cut.mkv",
    // Allow bounded splice/mux padding; precise mode above uses a tighter bound.
    { format: /matroska/, durationSeconds: 20, toleranceSeconds: 0.5, audio: true },
  );
});
