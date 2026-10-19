import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test as base, type BrowserContext } from "@playwright/test";
import { startApp } from "./app";

const run = promisify(execFile);
export type App = Awaited<ReturnType<typeof startApp>>;

export async function connectContext(context: BrowserContext, app: App) {
  await context.addInitScript(
    ({ token }) => {
      window.VIDEOCUTLIST_CONFIG = {
        serverBaseUrl: window.location.origin,
        authentication: { type: "bearer", token },
      };
    },
    { token: app.token },
  );
}

export const test = base.extend<{ app: App }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright requires destructured fixture dependencies.
  app: async ({}, use, testInfo) => {
    const directory = await mkdtemp(resolve(tmpdir(), "videocutlist-e2e-app-"));
    let app: App | undefined;
    try {
      const media = resolve(directory, "media");
      await mkdir(media);
      const source = resolve(media, "sintel-trailer.mp4");
      await copyFile(resolve("../test/fixtures/real-media/sintel-trailer.mp4"), source);
      await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          source,
          "-map",
          "0",
          "-c",
          "copy",
          resolve(media, "sintel-trailer.mkv"),
        ],
        { timeout: 30_000 },
      );
      app = await startApp(directory, randomBytes(32).toString("hex"));
      await use(app);
    } finally {
      try {
        if (app) {
          await app.stop();
          const raceDetected = app.logs.includes("WARNING: DATA RACE");
          if (raceDetected || testInfo.status !== testInfo.expectedStatus) {
            await testInfo.attach("server.log", { body: app.logs, contentType: "text/plain" });
          }
          expect(raceDetected, "Go race detector must remain clean; see server.log").toBe(false);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  baseURL: async ({ app }, use) => {
    await use(app.baseURL);
  },
  context: async ({ context, app }, use) => {
    await connectContext(context, app);
    await use(context);
  },
});

export { expect } from "@playwright/test";
