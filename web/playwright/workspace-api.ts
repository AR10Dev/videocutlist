import type { Page } from "@playwright/test";
import { mediaFixture } from "./fixtures";

const origin = "http://127.0.0.1:8787";

export async function mockWorkspaceApi(page: Page, writes: unknown[]) {
  await page.route(`${origin}/api/v2/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v2/media/tree")
      return route.fulfill({ json: { folders: [], items: [mediaFixture] } });
    if (url.pathname === `/api/v2/media/${mediaFixture.id}`)
      return route.fulfill({ json: mediaFixture });
    if (url.pathname === "/api/v2/media/status")
      return route.fulfill({ json: { state: "ready_with_media", message: "Ready" } });
    if (url.pathname === `/api/v2/export-capabilities/media/${mediaFixture.id}`)
      return route.fulfill({
        json: {
          strategies: [
            { strategy: "stream_copy_preferred", supported: true, reasons: [] },
            { strategy: "precise_reencode", supported: true, reasons: [] },
            { strategy: "hybrid_smart_cut", supported: true, reasons: [] },
          ],
        },
      });
    if (url.pathname === "/api/v2/projects/import" && request.method() === "POST") {
      const { content } = request.postDataJSON() as { content: string };
      const document = JSON.parse(content) as { name: string; items: unknown[] };
      return route.fulfill({
        json: {
          sourceFormat: "v2",
          document: { revision: 0, schemaVersion: 2, name: document.name, items: document.items },
        },
      });
    }
    if (url.pathname === "/api/v2/settings") return route.fulfill({ json: {} });
    if (url.pathname === "/api/v2/destinations")
      return route.fulfill({ json: { destinations: [] } });
    if (url.pathname === "/api/v2/batches") return route.fulfill({ json: { items: [] } });
    if (request.method() === "PUT" && /^\/api\/v2\/projects\/[^/]+$/.test(url.pathname)) {
      const body = request.postDataJSON();
      writes.push(body);
      return route.fulfill({
        json: {
          ...body,
          id: url.pathname.split("/").at(-1),
          revision: writes.length,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
    }
    return route.fulfill({ status: 404 });
  });
}
