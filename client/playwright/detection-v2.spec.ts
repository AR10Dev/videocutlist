import { expect, test, type Page } from "@playwright/test";
import type { components } from "../src/generated/api";

const origin = "http://127.0.0.1:8787";
const media = {
  id: "m_0123456789012345678901234567890123456789012",
  name: "camera.mp4",
  durationMs: 10_000,
  sizeBytes: 1000,
  container: "mp4",
  streams: { tracks: [{ index: 0, type: "video", codec: "h264" }] },
  etag: "fingerprint-v1",
} satisfies components["schemas"]["Media"];
const settings = {
  revision: 1,
  schemaVersion: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  pathsConstrained: false,
  roots: { media: { state: "ready" } },
  settings: {
    destinations: [],
    exportLimit: 1,
    cacheMaxBytes: 1_000_000,
    previewGlobalLimit: 2,
    previewBeforeMs: 1000,
    previewAfterMs: 1000,
    previewMaxMs: 5000,
    previewGridMs: 1000,
    mediaMaxFiles: 100,
    mediaMaxDepth: 4,
    mcpEnabled: false,
  },
} satisfies components["schemas"]["SettingsResponse"];

async function addToProject(page: Page) {
  await page.getByRole("button", { name: "Select camera.mp4" }).click();
  await page.getByRole("button", { name: "Add to project" }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
    Object.defineProperty(window, "MediaSource", { value: undefined });
  });
  await page.route(`${origin}/api/v2/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/v2/settings") return route.fulfill({ json: settings });
    if (path === "/api/v2/settings/mcp")
      return route.fulfill({
        json: {
          enabled: false,
          endpoint: "/mcp",
          credentials: [],
          permissions: [],
          roots: [],
          proposals: [],
          authentication: "Bearer token",
          remoteAccessGuidance: "Use HTTPS for remote access.",
          clientCompatibility: "Streamable HTTP bearer-token clients only.",
        } satisfies components["schemas"]["MCPSettingsResponse"],
      });
    if (path === "/api/v2/media/status")
      return route.fulfill({ json: { state: "ready_with_media", message: "Library ready." } });
    if (path === "/api/v2/media/tree")
      return route.fulfill({ json: { folders: [], items: [media] } });
    if (path === `/api/v2/media/${media.id}`) return route.fulfill({ json: media });
    if (path === "/api/v2/projects")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/v2/batches") return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/v2/destinations") return route.fulfill({ json: { destinations: [] } });
    if (path === `/api/v2/media/${media.id}/thumbnails`) return route.fulfill({ status: 404 });
    if (path === `/api/v2/media/${media.id}/waveform`)
      return route.fulfill({
        json: { startMs: 0, durationMs: media.durationMs, peaks: [0.2, 0.8] },
      });
    if (/^\/api\/v2\/projects\/[^/]+$/.test(path))
      return request.method() === "PUT"
        ? route.fulfill({
            json: {
              ...request.postDataJSON(),
              id: path.split("/").pop(),
              revision: 1,
              updatedAt: "2026-01-01T00:00:00Z",
            },
          })
        : route.fulfill({ status: 404 });
    return route.fulfill({ status: 404 });
  });
});

test("detection saves then submits a keyed source/item revision and reviews the SSE result", async ({
  page,
}) => {
  const calls: string[] = [];
  let submitted: { input: components["schemas"]["DetectionInput"]; key: string | null } | undefined;
  let savedProject: components["schemas"]["Project"] | undefined;
  await page.route(`${origin}/api/v2/projects/*/detections`, async (route) => {
    calls.push("submit");
    const request = route.request();
    submitted = {
      input: request.postDataJSON() as components["schemas"]["DetectionInput"],
      key: request.headers()["idempotency-key"] ?? null,
    };
    const projectId = new URL(request.url()).pathname.split("/")[4]!;
    const input = submitted.input;
    return route.fulfill({
      status: 202,
      json: {
        id: "j_012345678901",
        type: "detection",
        state: "queued",
        mediaId: input.mediaId,
        projectId,
        projectRevision: input.projectRevision,
        kind: input.kind,
      } satisfies components["schemas"]["DetectionJob"],
    });
  });
  await page.route(`${origin}/api/v2/jobs/j_012345678901/events`, (route) => {
    calls.push("observe");
    expect(route.request().headers().accept).toContain("text/event-stream");
    const input = submitted?.input;
    if (!input || !savedProject) return route.fulfill({ status: 500 });
    const job = {
      id: "j_012345678901",
      type: "detection",
      state: "succeeded",
      mediaId: input.mediaId,
      projectId: savedProject.id,
      projectRevision: input.projectRevision,
      kind: input.kind,
      candidates: [
        {
          id: "c_012345678901",
          mediaId: input.mediaId,
          projectId: savedProject.id,
          projectRevision: input.projectRevision,
          startMs: 100,
          endMs: 800,
          source: "black",
        },
      ],
      revision: 2,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
    };
    return route.fulfill({
      headers: { "content-type": "text/event-stream" },
      body: `id: 2\nevent: snapshot\ndata: ${JSON.stringify(job)}\n\n`,
    });
  });
  await page.route(`${origin}/api/v2/projects/*`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    calls.push("save");
    const projectId = new URL(route.request().url()).pathname.split("/").pop()!;
    savedProject = {
      ...route.request().postDataJSON(),
      id: projectId,
      revision: 1,
      updatedAt: "2026-01-01T00:00:00Z",
    } as components["schemas"]["Project"];
    return route.fulfill({ json: savedProject });
  });

  await page.goto("/");
  await addToProject(page);
  await page.getByRole("tab", { name: "Auto-detect", exact: true }).click();
  await page.getByRole("button", { name: "Find black sections", exact: true }).click();
  await expect
    .poll(() => submitted)
    .toMatchObject({
      key: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/),
      input: {
        mediaId: media.id,
        projectItemId: expect.any(String),
        projectRevision: 1,
        sourceFingerprint: media.etag,
        kind: "black",
      },
    });
  await expect(page.getByRole("button", { name: "Add segment", exact: true })).toBeVisible();
  expect(savedProject?.id).toMatch(/^p_[A-Za-z0-9_-]{12,64}$/);
  expect(submitted?.input.projectItemId).toMatch(/^i_[A-Za-z0-9_-]{12,64}$/);
  expect(savedProject?.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: submitted?.input.projectItemId, mediaId: media.id }),
    ]),
  );
  expect(calls.slice(0, 3)).toEqual(["save", "submit", "observe"]);
  await page.getByRole("button", { name: "Add segment", exact: true }).click();
  await expect(page.getByText("All candidates reviewed", { exact: true })).toBeVisible();
});
