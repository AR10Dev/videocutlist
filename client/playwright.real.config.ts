import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = 18787;
const baseURL = `http://127.0.0.1:${port}`;
// webServer starts before globalSetup; workers can also reload this config.
// Only the main runner's server command creates its unique directory.
const realUiDir = resolve("..", ".cache", `real-ui.${randomUUID()}`);

export default defineConfig({
  testDir: "./playwright-real",
  workers: 1,
  timeout: 180_000,
  use: { baseURL, trace: "retain-on-failure" },
  reporter: [["./playwright-real/cleanup-reporter.ts", { directory: realUiDir }]],
  webServer: {
    command: `mkdir -p "$REAL_UI_DIR/cache" "$REAL_UI_DIR/exports" "$REAL_UI_DIR/media" && cp test/fixtures/real-media/sintel-trailer.mp4 "$REAL_UI_DIR/media/" && ffmpeg -v error -i test/fixtures/real-media/sintel-trailer.mp4 -map 0 -c copy "$REAL_UI_DIR/media/sintel-trailer.mkv" && VIDEOCUTLIST_DATABASE_PATH="$REAL_UI_DIR/videocutlist.db" VIDEOCUTLIST_CACHE_DIR="$REAL_UI_DIR/cache" VIDEOCUTLIST_EXPORT_DIR="$REAL_UI_DIR/exports" VIDEOCUTLIST_MEDIA_ROOTS_JSON="{\\"fixture\\":\\"$REAL_UI_DIR/media\\"}" VIDEOCUTLIST_LISTEN_ADDRESS=127.0.0.1 VIDEOCUTLIST_PORT=${port} VIDEOCUTLIST_AUTH_MODE=bearer VIDEOCUTLIST_BEARER_TOKEN=real-media-test-token go run ./cmd/videocutlist`,
    cwd: "..",
    env: { REAL_UI_DIR: realUiDir },
    url: `${baseURL}/api/v1/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
