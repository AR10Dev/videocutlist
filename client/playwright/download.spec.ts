import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { expect, test, type Page } from "@playwright/test";

const token = "test-only-download-token";

async function exportServer(onResponse: (response: ServerResponse) => void) {
  let authorized = 0;
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
    response.setHeader("Access-Control-Allow-Headers", "Authorization");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (
      request.url !== "/api/v1/jobs/job_123/outputs/0" ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(401).end();
      return;
    }
    authorized++;
    onResponse(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => authorized,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function startDownload(page: Page, baseUrl: string, cancelAfterStart = false) {
  return page.evaluate(
    async ({ baseUrl, token, cancelAfterStart }) => {
      // page.evaluate runs in Chromium, not the Playwright Node module graph.
      const { createApiClient } = await import(/* @vite-ignore */ `${location.origin}/src/api.ts`);
      const { downloadExport } = await import(
        /* @vite-ignore */ `${location.origin}/src/features/export/download.ts`
      );
      const authentication = { type: "bearer" as const, token };
      const api = createApiClient({ serverBaseUrl: baseUrl, authentication });
      const controller = new AbortController();
      if (cancelAfterStart)
        (window as Window & { cancelDownload?: () => void }).cancelDownload = () =>
          controller.abort();
      return downloadExport(
        api,
        "jobs/job_123/outputs/0",
        "camera.mp4",
        authentication,
        controller.signal,
      );
    },
    { baseUrl, token, cancelAfterStart },
  );
}

test("first-use cross-origin bearer download saves streamed bytes without a page Blob", async ({
  page,
}, testInfo) => {
  const bytes = 8 * 1024 * 1024;
  const server = await exportServer((response) => {
    response.writeHead(200, { "Content-Length": bytes, "Content-Type": "video/mp4" });
    for (let sent = 0; sent < bytes; sent += 64 * 1024)
      response.write(Buffer.alloc(64 * 1024, sent / (64 * 1024)));
    response.end();
  });
  try {
    await page.goto("/");
    await page.evaluate(() => {
      Response.prototype.blob = () => {
        throw new Error("Page must never buffer a Blob.");
      };
      URL.createObjectURL = () => {
        throw new Error("Page must never create a Blob URL.");
      };
    });
    const arriving = page.waitForEvent("download");
    const transfer = startDownload(page, server.url);
    const download = await arriving;
    expect(download.suggestedFilename()).toBe("camera.mp4");
    expect(download.url()).toMatch(/^http:\/\/127\.0\.0\.1:5173\/download-stream\/[0-9a-f-]{36}$/);
    const path = testInfo.outputPath("camera.mp4");
    await download.saveAs(path);
    await transfer;
    expect((await stat(path)).size).toBe(bytes);
    expect(server.requests()).toBe(1);
  } finally {
    await server.close();
  }
});

test("canceling a streamed export aborts the protected upstream request", async ({ page }) => {
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
  const server = await exportServer((response) => {
    response.writeHead(200, { "Content-Type": "video/mp4" });
    response.write(Buffer.alloc(64 * 1024));
    response.on("close", upstreamClosed);
  });
  try {
    await page.goto("/");
    const arriving = page.waitForEvent("download");
    const transfer = startDownload(page, server.url, true).then(
      () => undefined,
      (error: unknown) => error,
    );
    await arriving;
    await page.evaluate(() => {
      const cancel = (window as Window & { cancelDownload?: () => void }).cancelDownload;
      if (!cancel) throw new Error("Download cancellation is not available.");
      cancel();
    });
    const error = await transfer;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Download cancelled.");
    await closed;
    expect(server.requests()).toBe(1);
  } finally {
    await server.close();
  }
});

test("unauthorized streamed download opens the shared access gate", async ({ page }) => {
  const server = await exportServer((response) => {
    response.writeHead(401).end();
  });
  try {
    await page.goto("/");
    await expect(startDownload(page, server.url)).rejects.toThrow(
      "Download failed (401). Try again.",
    );
    await expect(page.getByRole("heading", { name: "VideoCutlist access" })).toBeVisible();
    expect(server.requests()).toBe(1);
  } finally {
    await server.close();
  }
});
