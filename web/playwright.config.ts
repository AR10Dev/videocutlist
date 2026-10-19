import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright-real",
  globalSetup: "./playwright-real/setup.ts",
  workers: 1,
  outputDir: "test-results/real",
  timeout: 180_000,
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
