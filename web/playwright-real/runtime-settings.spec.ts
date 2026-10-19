import { randomUUID } from "node:crypto";
import { link } from "node:fs/promises";
import { join } from "node:path";
import type { SettingsResponse } from "../src/generated/effect-api";
import { expect, test } from "./fixtures";

test("live settings preserve job finalization metrics while real scans complete", async ({
  request,
  app,
}) => {
  const headers = { Authorization: `Bearer ${app.token}` };
  const completions = async () => {
    const response = await request.get("/metrics", { headers });
    expect(response.ok()).toBe(true);
    const match = (await response.text()).match(
      /^job_terminal_finalization_duration_seconds_count (\d+)$/m,
    );
    expect(match).not.toBeNull();
    return Number(match![1]);
  };
  const before = await completions();
  for (let i = 0; i < 5; i++) {
    const response = await request.get("/api/v2/settings", { headers });
    expect(response.ok()).toBe(true);
    const settings = (await response.json()) as SettingsResponse;
    const [update, refresh] = await Promise.all([
      request.put("/api/v2/settings", {
        headers,
        data: {
          revision: settings.revision,
          settings: { ...settings.settings, exportLimit: (i % 2) + 1 },
        },
      }),
      request.post("/api/v2/settings/media/refresh", {
        headers: { ...headers, "Idempotency-Key": randomUUID() },
      }),
    ]);
    expect(update.status()).toBe(200);
    expect(refresh.status()).toBe(202);
    await expect.poll(completions).toBeGreaterThanOrEqual(before + i + 1);
  }
});

test("settings apply before an in-progress real library scan completes", async ({
  request,
  app,
}) => {
  const headers = { Authorization: `Bearer ${app.token}` };
  // Real inputs keep FFprobe busy; no delayed routes or fabricated scan state.
  for (let i = 0; i < 80; i++)
    await link(join(app.mediaRoot, "sintel-trailer.mp4"), join(app.mediaRoot, `scan-${i}.mp4`));
  const settingsResponse = await request.get("/api/v2/settings", { headers });
  expect(settingsResponse.ok()).toBe(true);
  const settings = (await settingsResponse.json()) as SettingsResponse;
  const status = async () => {
    const response = await request.get("/api/v2/media/status", { headers });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const refresh = await request.post("/api/v2/settings/media/refresh", {
    headers: { ...headers, "Idempotency-Key": randomUUID() },
  });
  expect(refresh.status()).toBe(202);
  await expect.poll(async () => (await status()).roots.fixture.state).toBe("scanning");
  const update = await request.put("/api/v2/settings", {
    headers,
    data: {
      revision: settings.revision,
      settings: { ...settings.settings, mediaMaxFiles: settings.settings.mediaMaxFiles + 1 },
    },
  });
  expect(update.status()).toBe(200);
  expect((await status()).roots.fixture.state).toBe("scanning");
  await expect
    .poll(async () => (await status()).state, { timeout: 30_000 })
    .toBe("ready_with_media");
});
