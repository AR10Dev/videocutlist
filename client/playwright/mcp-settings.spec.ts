import { expect, test } from "@playwright/test";
import type { components } from "../src/generated/api";

type Schema = components["schemas"];
const origin = "http://127.0.0.1:8787/api/v1";
const credential: Schema["MCPCredential"] = {
  id: "credential-1",
  tokenIdentifier: "token-1",
  name: "Scoped assistant",
  permissions: ["media:read"],
  mediaScope: { kind: "roots", rootIds: ["interviews"] },
  projectScope: { kind: "projects", projectIds: ["project-1"] },
  unattendedExports: true,
  createdAt: "2026-01-01T00:00:00Z",
  status: "active",
};
const proposal: Schema["ExportProposal"] = {
  id: "proposal-1",
  credentialId: credential.id,
  projectId: "project-1",
  projectRevision: 3,
  allowed: true,
  requiresReencoding: false,
  accuracy: "keyframe_limited",
  destinationId: "download",
  createdAt: "2026-01-01T00:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
  findings: [],
  snapshots: [
    {
      projectRevision: 3,
      mediaLabel: "Interview",
      source: { mediaId: "media-1", etag: "v1", sizeBytes: 100, durationMs: 10000 },
      item: {
        id: "item-1",
        mediaId: "media-1",
        segments: [
          { startMs: 1000, endMs: 2000, included: true },
          { startMs: 4000, endMs: 5000, included: false },
        ],
        exportOptions: {
          selection: "gaps",
          mode: "separate",
          streamIndexes: [0, 2],
          filenameTemplate: "review-{segment}.{ext}",
          container: "mp4",
          cutStrategy: "stream_copy_preferred",
        },
      },
    },
  ],
};
const initial: Schema["MCPSettingsResponse"] = {
  enabled: false,
  endpoint: "/mcp",
  authentication: "Bearer token",
  remoteAccessGuidance: "Use HTTPS remotely.",
  clientCompatibility: "Bearer clients only.",
  permissions: ["media:read"],
  roots: [{ id: "interviews", label: "Interviews" }],
  credentials: [],
  proposals: [],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.VIDEOCUTLIST_CONFIG = {
      serverBaseUrl: "http://127.0.0.1:8787",
      authentication: { type: "none" },
    };
  });
  await page.route(`${origin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/settings"))
      return route.fulfill({
        json: {
          revision: 1,
          schemaVersion: 1,
          updatedAt: "2026-01-01T00:00:00Z",
          pathsConstrained: true,
          roots: {},
          settings: {
            destinations: [
              {
                id: "download",
                label: "Downloads",
                kind: "download",
                description: "Deployment destination",
                retention: "24h",
              },
            ],
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
        } satisfies Schema["SettingsResponse"],
      });
    if (path.endsWith("/media/status"))
      return route.fulfill({ json: { state: "ready_empty", message: "Empty" } });
    if (path.endsWith("/media/tree")) return route.fulfill({ json: { folders: [], items: [] } });
    if (path.endsWith("/batches")) return route.fulfill({ json: { items: [] } });
    if (path.endsWith("/destinations")) return route.fulfill({ json: { destinations: [] } });
    return route.fulfill({ status: 404 });
  });
});

test("MCP refresh, pagination, exact approval, scopes and revoke remain reachable", async ({
  page,
}) => {
  let refreshed = false;
  let failed = false;
  let revoked = false;
  let approved = false;
  await page.route(`${origin}/settings/mcp*`, (route) => {
    if (failed) return route.fulfill({ status: 503 });
    const params = new URL(route.request().url()).searchParams;
    const more = params.get("cursor") === "page-2";
    const proposalMore = params.get("proposalCursor") === "proposal-page-2";
    return route.fulfill({
      json: {
        ...initial,
        credentials: more
          ? [
              {
                ...credential,
                id: "credential-2",
                name: "Later assistant",
                status: revoked ? "revoked" : "active",
              },
            ]
          : [credential],
        nextCursor: more ? undefined : "page-2",
        proposals:
          refreshed && !approved
            ? proposalMore
              ? [{ ...proposal, id: "proposal-2" }]
              : [proposal]
            : [],
        proposalNextCursor: refreshed && !approved && !proposalMore ? "proposal-page-2" : undefined,
      } satisfies Schema["MCPSettingsResponse"],
    });
  });
  await page.route(`${origin}/export-proposals/proposal-1/approval`, (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postData()).toBeNull();
    approved = true;
    return route.fulfill({
      json: { ...proposal, approvedAt: "2026-01-01T00:01:00Z" } satisfies Schema["ExportProposal"],
    });
  });
  await page.route(`${origin}/settings/mcp/credentials/credential-2`, (route) => {
    expect(route.request().method()).toBe("DELETE");
    revoked = true;
    failed = true;
    return route.fulfill({
      json: {
        ...credential,
        id: "credential-2",
        status: "revoked",
      } satisfies Schema["MCPCredential"],
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("No export proposals are awaiting approval.")).toBeVisible();
  await expect(
    page.getByText("Destinations are deployment-managed and read-only.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save destination settings" })).toHaveCount(0);
  await expect(page.getByText("Media scope: roots — roots: interviews")).toBeVisible();
  await expect(page.getByText("Project scope: projects — project IDs: project-1")).toBeVisible();
  await expect(page.getByText("Unattended exports: allowed (no in-app approval)")).toBeVisible();
  refreshed = true;
  await page.getByRole("button", { name: "Refresh MCP settings" }).click();
  const proposals = page.getByRole("list", { name: "MCP export proposals" });
  for (const detail of [
    "Requesting credential: credential-1",
    "Selection: gaps; arrangement: separate",
    "Selected streams: 0, 2",
    "Filename template: review-{segment}.{ext}",
    "Effective output ranges: 0–1000 ms, 2000–10000 ms",
    "4000–5000 ms (excluded)",
    "container mp4",
    "keyframe_limited",
  ])
    await expect(proposals).toContainText(detail);
  await page.getByRole("button", { name: "Load more proposals" }).click();
  await expect(proposals).toContainText("Proposal proposal-2");
  await page.getByRole("button", { name: "Approve exact proposal" }).first().click();
  await expect(page.getByText("No export proposals are awaiting approval.")).toBeVisible();
  await page.getByRole("button", { name: "Load more credentials" }).click();
  await expect(page.getByRole("button", { name: "Revoke Scoped assistant" })).toBeVisible();
  await page.getByRole("button", { name: "Revoke Later assistant" }).click();
  await expect(page.getByRole("alert")).toContainText("Displayed data may be outdated");
  await expect(page.getByText("MCP credential revoked.")).toBeVisible();
  failed = false;
  await page.getByRole("button", { name: "Refresh MCP settings" }).click();
  await page.getByRole("button", { name: "Load more credentials" }).click();
  await expect(page.getByRole("button", { name: "Revoke Later assistant" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("MCP initial errors survive general settings load and have a working retry", async ({
  page,
}) => {
  let failed = true;
  await page.route(`${origin}/settings/mcp`, (route) =>
    route.fulfill(failed ? { status: 503 } : { json: initial }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Retry refresh");
  await expect(page.getByText("Loading MCP administration settings…")).toHaveCount(0);
  failed = false;
  await page.getByRole("button", { name: "Refresh MCP settings" }).click();
  await expect(page.getByText("No MCP credentials created.")).toBeVisible();
});

test("MCP secret is creation-only including a response arriving after dismissal", async ({
  page,
}) => {
  await page.route(`${origin}/settings/mcp`, (route) => route.fulfill({ json: initial }));
  let release: (() => void) | undefined;
  let delay = false;
  await page.route(`${origin}/settings/mcp/credentials`, async (route) => {
    if (delay)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({
      status: 201,
      json: {
        ...credential,
        secret: "vcl_test-only-secret",
      } satisfies Schema["MCPCredentialCreated"],
    });
  });
  await page.goto("/");
  const open = () => page.getByRole("button", { name: "Settings", exact: true }).click();
  const create = async () => {
    await page.getByLabel("Credential name", { exact: true }).fill("Assistant");
    await page.getByRole("button", { name: "Create credential", exact: true }).click();
  };
  await open();
  await create();
  await expect(page.getByLabel("One-time MCP bearer secret")).toHaveValue("vcl_test-only-secret");
  await page.getByRole("button", { name: "Back to editor" }).click();
  await open();
  await expect(page.getByLabel("One-time MCP bearer secret")).toHaveCount(0);
  delay = true;
  await create();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole("button", { name: "Back to editor" }).click();
  await open();
  release!();
  await expect(page.getByRole("button", { name: "Create credential", exact: true })).toBeEnabled();
  await expect(page.getByLabel("One-time MCP bearer secret")).toHaveCount(0);
});
