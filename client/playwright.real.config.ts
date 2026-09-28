import { defineConfig, devices } from "@playwright/test";

const port = 18787;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./playwright-real",
  workers: 1,
  timeout: 180_000,
  use: { baseURL, trace: "retain-on-failure" },
  webServer: {
    command: `cd .. && mkdir -p .cache && real_ui_dir="$(mktemp -d .cache/real-ui.XXXXXX)" && trap 'rm -rf "$real_ui_dir"' EXIT && mkdir -p "$real_ui_dir/cache" "$real_ui_dir/exports" "$real_ui_dir/media" && cp test/fixtures/real-media/sintel-trailer.mp4 "$real_ui_dir/media/" && ffmpeg -v error -i test/fixtures/real-media/sintel-trailer.mp4 -map 0 -c copy "$real_ui_dir/media/sintel-trailer.mkv" && VIDEOCUTLIST_DATABASE_PATH="$PWD/$real_ui_dir/videocutlist.db" VIDEOCUTLIST_CACHE_DIR="$PWD/$real_ui_dir/cache" VIDEOCUTLIST_EXPORT_DIR="$PWD/$real_ui_dir/exports" VIDEOCUTLIST_MEDIA_ROOTS_JSON="{\\"fixture\\":\\"$PWD/$real_ui_dir/media\\"}" VIDEOCUTLIST_LISTEN_ADDRESS=127.0.0.1 VIDEOCUTLIST_PORT=${port} VIDEOCUTLIST_AUTH_MODE=bearer VIDEOCUTLIST_BEARER_TOKEN=real-media-test-token go run ./cmd/videocutlist`,
    url: `${baseURL}/api/v1/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
