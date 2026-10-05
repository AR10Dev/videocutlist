import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const serverBase = "http://127.0.0.1:8787/deploy";
const media = {
  id: "m_0123456789012345678901234567890123456789012",
  name: "camera.mp4",
  durationMs: 10_000,
  sizeBytes: 1000,
  container: "mp4",
  streams: {},
  etag: "v1",
};

async function openProjectTools(page: import("@playwright/test").Page) {
  const mediaToggle = page.getByRole("button", { name: /media library/ }).first();
  if ((await mediaToggle.getAttribute("aria-expanded")) === "false") await mediaToggle.click();
  await page.locator(".project-menu > summary").click();
  await page.getByRole("button", { name: "Project tools", exact: true }).click();
  await page.getByText("Interchange", { exact: true }).click();
}

test("imports text through generated v2 control and downloads native interchange attachments", async ({
  page,
}, testInfo) => {
  const importRequests: { path: string; contentType: string | undefined; body: string }[] = [];
  const nativeRequests: { path: string }[] = [];
  let savedProject: Record<string, unknown> | undefined;
  await page.addInitScript((base) => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: base,
      authentication: { type: "none" },
    };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    window.__interchangeUrls = { created: [], revoked: [] };
    window.__interchangeBlobs = [];
    window.__heldInterchange = { enabled: false, started: false, cancelled: false };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (window.__heldInterchange.enabled && String(input).includes("/media/v2/projects/")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            window.__heldInterchange.started = true;
            controller.enqueue(new TextEncoder().encode("start,end,label\\n"));
          },
          cancel() {
            window.__heldInterchange.cancelled = true;
          },
        });
        return new Response(body, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="cutlist.csv"',
          },
        });
      }
      return originalFetch(input, init);
    };
    URL.createObjectURL = (object) => {
      const url = create(object);
      if (
        object instanceof Blob &&
        (object.type.startsWith("text/csv") || object.type.startsWith("text/plain"))
      ) {
        window.__interchangeUrls.created.push(url);
        void object
          .text()
          .then((text) => window.__interchangeBlobs.push({ type: object.type, text }));
      }
      return url;
    };
    URL.revokeObjectURL = (url) => {
      if (window.__interchangeUrls.created.includes(url))
        window.__interchangeUrls.revoked.push(url);
      revoke(url);
    };
  }, serverBase);
  await page.route(`${serverBase}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/deploy/api/v2/media/tree")
      return route.fulfill({ json: { folders: [], items: [media], nextCursor: null } });
    if (url.pathname === `/deploy/api/v2/media/${media.id}`) return route.fulfill({ json: media });
    if (url.pathname === "/deploy/api/v2/media/status")
      return route.fulfill({ json: { state: "ready_with_media", message: "Ready" } });
    if (url.pathname === "/deploy/api/v2/settings") return route.fulfill({ json: {} });
    if (url.pathname === "/deploy/api/v2/destinations")
      return route.fulfill({ json: { destinations: [] } });
    if (url.pathname === "/deploy/api/v2/batches")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (request.method() === "PUT" && /^\/deploy\/api\/v2\/projects\/[^/]+$/.test(url.pathname)) {
      const body = request.postDataJSON() as Record<string, unknown>;
      savedProject = {
        ...body,
        id: url.pathname.split("/").at(-1),
        revision: Number(body.revision) + 1,
        updatedAt: "2026-01-01T00:00:00Z",
      };
      return route.fulfill({ json: savedProject });
    }
    if (request.method() === "POST" && /\/interchange\/(csv|chapters)$/.test(url.pathname)) {
      const body = request.postData() ?? "";
      importRequests.push({
        path: `${url.pathname}${url.search}`,
        contentType: request.headers()["content-type"],
        body,
      });
      if (body === "CONFLICT")
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "revision_conflict",
              message: "Project revision changed.",
              requestId: "browser",
            },
          },
        });
      if (body.includes("not-a-timestamp"))
        return route.fulfill({
          status: 400,
          json: {
            error: {
              code: "invalid_input",
              message: "Invalid cut-list timestamp.",
              requestId: "browser",
            },
          },
        });
      const current = savedProject as Record<string, unknown>;
      const items = current.items as Array<Record<string, unknown>>;
      const active = items[0]!;
      savedProject = {
        ...current,
        revision: Number(current.revision) + 1,
        items: [{ ...active, segments: [{ startMs: 500, endMs: 1500, label: body }] }],
      };
      return route.fulfill({ json: savedProject });
    }
    if (request.method() === "GET" && /^\/deploy\/api\/v2\/projects\/[^/]+$/.test(url.pathname))
      return route.fulfill({ json: savedProject });
    if (url.pathname.startsWith("/deploy/media/v2/projects/")) {
      const format = url.pathname.endsWith("/csv") ? "csv" : "chapters";
      nativeRequests.push({ path: `${url.pathname}${url.search}` });
      return route.fulfill({
        headers: {
          "Content-Type":
            format === "csv" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="cutlist.${format}"`,
        },
        body:
          format === "csv"
            ? "start,end,label\n00:00:00.500,00:00:01.500,Opening\n"
            : "00:00:00.500 --> 00:00:01.500 Opening\n",
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: "not_found", message: "Missing", requestId: "browser" } },
    });
  });

  await page.goto("./");
  await page.getByRole("button", { name: /camera\.mp4/ }).click();
  await page.getByRole("button", { name: "Add to project" }).click();
  await openProjectTools(page);
  await page.getByLabel("Import cut list", { exact: true }).setInputFiles({
    name: "review.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("start,end,label\n00:00:00.500,00:00:01.500,Opening\n"),
  });
  await expect.poll(() => importRequests.length).toBe(1);
  await expect(page.getByText("Project loaded.")).toBeVisible();
  expect(importRequests).toHaveLength(1);
  expect(importRequests[0]).toMatchObject({
    path: expect.stringMatching(
      /^\/deploy\/api\/v2\/projects\/p_[^/]+\/interchange\/csv\?itemId=i_/,
    ),
    contentType: "text/csv",
    body: "start,end,label\n00:00:00.500,00:00:01.500,Opening\n",
  });

  await page.getByLabel("Import cut list", { exact: true }).setInputFiles({
    name: "chapters.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("00:00:00.500 --> 00:00:01.500 Opening\n"),
  });
  await expect.poll(() => importRequests.length).toBe(2);
  expect(importRequests[1]).toMatchObject({
    path: expect.stringMatching(
      /^\/deploy\/api\/v2\/projects\/p_[^/]+\/interchange\/chapters\?itemId=i_/,
    ),
    contentType: "text/csv",
    body: "00:00:00.500 --> 00:00:01.500 Opening\n",
  });

  await page.getByLabel("Import cut list", { exact: true }).setInputFiles({
    name: "invalid.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("start,end,label\nnot-a-timestamp,00:00:01.500,Bad\n"),
  });
  await expect.poll(() => importRequests.length).toBe(3);
  await expect(page.getByText("Cut list import failed.", { exact: true })).toBeVisible();
  await page.getByLabel("Import cut list", { exact: true }).setInputFiles({
    name: "conflict.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("CONFLICT"),
  });
  await expect.poll(() => importRequests.length).toBe(4);
  await expect(page.getByText("Cut list import failed.", { exact: true })).toBeVisible();
  expect(savedProject).toMatchObject({ schemaVersion: 2, revision: 3 });

  const csvDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV cut list" }).click();
  const csvDownload = await csvDownloadPromise;
  expect(csvDownload.suggestedFilename()).toBe("cutlist.csv");
  const csvPath = testInfo.outputPath("native-interchange.csv");
  await csvDownload.saveAs(csvPath);
  expect(await readFile(csvPath, "utf8")).toBe(
    "start,end,label\n00:00:00.500,00:00:01.500,Opening\n",
  );
  const chapterDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download chapters" }).click();
  const chapterDownload = await chapterDownloadPromise;
  expect(chapterDownload.suggestedFilename()).toBe("cutlist.chapters");
  const chaptersPath = testInfo.outputPath("native-interchange.chapters");
  await chapterDownload.saveAs(chaptersPath);
  expect(await readFile(chaptersPath, "utf8")).toBe("00:00:00.500 --> 00:00:01.500 Opening\n");
  expect(nativeRequests).toHaveLength(2);
  expect(nativeRequests.map(({ path }) => path.startsWith("/deploy/media/v2/projects/"))).toEqual([
    true,
    true,
  ]);
  expect(nativeRequests.map(({ path }) => path.includes("?itemId=i_"))).toEqual([true, true]);
  await expect.poll(() => page.evaluate(() => window.__interchangeBlobs.length)).toBe(2);
  expect(await page.evaluate(() => window.__interchangeBlobs)).toEqual([
    {
      type: "text/csv; charset=utf-8",
      text: "start,end,label\n00:00:00.500,00:00:01.500,Opening\n",
    },
    {
      type: "text/plain; charset=utf-8",
      text: "00:00:00.500 --> 00:00:01.500 Opening\n",
    },
  ]);
  await expect.poll(() => page.evaluate(() => window.__interchangeUrls.revoked.length)).toBe(2);
  const urls = await page.evaluate(() => window.__interchangeUrls);
  expect(urls.created).toHaveLength(2);
  expect(urls.revoked).toEqual(urls.created);

  await page.evaluate(() => (window.__heldInterchange.enabled = true));
  await page.getByRole("button", { name: "Download CSV cut list" }).click();
  await expect.poll(() => page.evaluate(() => window.__heldInterchange.started)).toBe(true);
  await page.getByRole("button", { name: "Close project tools", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__heldInterchange.cancelled)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__interchangeUrls.created.length)).toBe(2);
});

declare global {
  interface Window {
    __interchangeUrls: { created: string[]; revoked: string[] };
    __interchangeBlobs: { type: string; text: string }[];
    __heldInterchange: { enabled: boolean; started: boolean; cancelled: boolean };
  }
}
