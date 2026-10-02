import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { expect, test, type Page } from "@playwright/test";

const token = "test-only-download-token";

async function exportServer(appOrigin: string, onResponse: (response: ServerResponse) => void) {
  let authorized = 0;
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", appOrigin);
    response.setHeader("Access-Control-Allow-Headers", "Authorization");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (
      request.url !== "/deploy/media/v2/jobs/job_123/outputs/0" ||
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

async function startDownload(
  page: Page,
  baseUrl: string,
  cancelAfterStart = false,
  name = "camera.mp4",
) {
  return page.evaluate(
    async ({ baseUrl, token, cancelAfterStart, name }) => {
      // page.evaluate runs in Chromium, not the Playwright Node module graph.
      const { createApiClient } = await import(
        /* @vite-ignore */ new URL("./src/api.ts", location.href).href
      );
      const { downloadExport } = await import(
        /* @vite-ignore */ new URL("./src/features/export/download.ts", location.href).href
      );
      const authentication = { type: "bearer" as const, token };
      const configuration = { serverBaseUrl: baseUrl, authentication };
      const api = createApiClient(configuration);
      (
        window as Window & { replaceDownloadAuthentication?: () => void }
      ).replaceDownloadAuthentication = () => {
        configuration.authentication = { type: "bearer", token: `${token}-new` };
      };
      const controller = new AbortController();
      if (cancelAfterStart)
        (window as Window & { cancelDownload?: () => void }).cancelDownload = () =>
          controller.abort();
      return downloadExport(api, "jobs/job_123/outputs/0", name, authentication, controller.signal);
    },
    { baseUrl, token, cancelAfterStart, name },
  );
}

test("first-use cross-origin bearer download saves streamed bytes without a page Blob", async ({
  page,
  baseURL,
}, testInfo) => {
  const bytes = 8 * 1024 * 1024;
  const name = "director's-cut*.mkv";
  const server = await exportServer(new URL(baseURL!).origin, (response) => {
    response.writeHead(200, { "Content-Length": bytes, "Content-Type": "video/mp4" });
    for (let sent = 0; sent < bytes; sent += 64 * 1024)
      response.write(Buffer.alloc(64 * 1024, sent / (64 * 1024)));
    response.end();
  });
  const session = await page.context().newCDPSession(page);
  await session.send("Network.enable");
  const dispositions: string[] = [];
  session.on("Network.responseReceived", ({ response }) => {
    if (response.url.includes("/download-stream/")) {
      const disposition = Object.entries(response.headers).find(
        ([key]) => key.toLowerCase() === "content-disposition",
      )?.[1];
      if (disposition) dispositions.push(disposition);
    }
  });
  try {
    await page.goto(baseURL!);
    await page.evaluate(() => {
      Response.prototype.blob = () => {
        throw new Error("Page must never buffer a Blob.");
      };
      URL.createObjectURL = () => {
        throw new Error("Page must never create a Blob URL.");
      };
    });
    const arriving = page.waitForEvent("download");
    const transfer = startDownload(page, `${server.url}/deploy`, false, name);
    const download = await arriving;
    // Chromium sanitizes '*' in the on-disk name even when filename* is valid.
    expect(download.suggestedFilename()).toBe("director's-cut_.mkv");
    expect(new URL(download.url()).origin).toBe(new URL(baseURL!).origin);
    expect(new URL(download.url()).pathname).toMatch(/^\/deploy\/download-stream\/[0-9a-f-]{36}$/);
    const path = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(path);
    await transfer;
    expect((await stat(path)).size).toBe(bytes);
    expect(server.requests()).toBe(1);
    expect(dispositions).toContain(
      `attachment; filename="${name}"; filename*=UTF-8''director%27s-cut%2A.mkv`,
    );
  } finally {
    await session.detach();
    await server.close();
  }
});

test("canceling a streamed export aborts the protected upstream request", async ({
  page,
  baseURL,
}) => {
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
  const server = await exportServer(new URL(baseURL!).origin, (response) => {
    response.writeHead(200, { "Content-Type": "video/mp4" });
    response.write(Buffer.alloc(64 * 1024));
    response.on("close", upstreamClosed);
  });
  try {
    await page.goto(baseURL!);
    const arriving = page.waitForEvent("download");
    const transfer = startDownload(page, `${server.url}/deploy`, true).then(
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

test("unauthorized streamed download opens the shared access gate", async ({ page, baseURL }) => {
  const server = await exportServer(new URL(baseURL!).origin, (response) => {
    response.writeHead(401).end();
  });
  try {
    await page.goto(baseURL!);
    await expect(startDownload(page, `${server.url}/deploy`)).rejects.toThrow(
      "Download failed (401). Try again.",
    );
    await expect(page.getByRole("heading", { name: "VideoCutlist access" })).toBeVisible();
    expect(server.requests()).toBe(1);
  } finally {
    await server.close();
  }
});

test("late 401 from a replaced download token does not reopen the access gate", async ({
  page,
  baseURL,
}) => {
  let respond!: () => void;
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => (received = resolve));
  const server = await exportServer(new URL(baseURL!).origin, (response) => {
    respond = () => response.writeHead(401).end();
    received();
  });
  try {
    await page.goto(baseURL!);
    const transfer = startDownload(page, `${server.url}/deploy`);
    await requestReceived;
    await page.evaluate(() => {
      const replace = (window as Window & { replaceDownloadAuthentication?: () => void })
        .replaceDownloadAuthentication;
      if (!replace) throw new Error("Download authentication was not initialized.");
      replace();
    });
    respond();
    await expect(transfer).rejects.toThrow("Download failed (401). Try again.");
    await expect(page.getByRole("heading", { name: "VideoCutlist access" })).toBeHidden();
    expect(server.requests()).toBe(1);
  } finally {
    await server.close();
  }
});
