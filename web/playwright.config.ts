import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright",
  use: { baseURL: "http://127.0.0.1:5173" },
  webServer: {
    command: "npm run build && npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
  },
});
