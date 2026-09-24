import { defineConfig, devices } from "@playwright/test";

const port = 18787;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./playwright-real",
  workers: 1,
  timeout: 180_000,
  use: { baseURL, trace: "retain-on-failure" },
  webServer: {
    command: `cd .. && rm -rf .cache/real-ui && mkdir -p .cache/real-ui/cache .cache/real-ui/exports .cache/real-ui/media && cp test/fixtures/real-media/sintel-trailer.mp4 .cache/real-ui/media/ && ffmpeg -v error -i test/fixtures/real-media/sintel-trailer.mp4 -map 0 -c copy .cache/real-ui/media/sintel-trailer.mkv && VIDEOCUTLIST_DATABASE_PATH="$PWD/.cache/real-ui/videocutlist.db" VIDEOCUTLIST_CACHE_DIR="$PWD/.cache/real-ui/cache" VIDEOCUTLIST_EXPORT_DIR="$PWD/.cache/real-ui/exports" VIDEOCUTLIST_MEDIA_ROOTS_JSON="{\\"fixture\\":\\"$PWD/.cache/real-ui/media\\"}" VIDEOCUTLIST_LISTEN_ADDRESS=127.0.0.1 VIDEOCUTLIST_PORT=${port} VIDEOCUTLIST_AUTH_MODE=bearer VIDEOCUTLIST_BEARER_TOKEN=real-media-test-token go run ./cmd/videocutlist`,
    url: `${baseURL}/api/v1/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
