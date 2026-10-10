import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  timeout: process.env.CI ? 60_000 : 30_000,
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 5173 --strictPort --base /deploy/",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: process.env.CI ? "chrome" : undefined },
    },
  ],
});
