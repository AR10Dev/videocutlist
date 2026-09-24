import { expect, test } from "@playwright/test";

test("authenticates existing API clients without persisting the deployment token", async ({
  page,
}) => {
  const token = "browser-test-deployment-token";
  await page.route("**/api/v1/**", async (route) => {
    if (route.request().headers().authorization !== `Bearer ${token}`)
      return route.fulfill({
        status: 401,
        json: {
          error: {
            code: "unauthenticated",
            message: "Authentication required.",
            requestId: "test",
          },
        },
      });
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/settings")) return route.fulfill({ json: {} });
    if (path.endsWith("/media/tree")) return route.fulfill({ json: { folders: [], items: [] } });
    if (path.endsWith("/media/status"))
      return route.fulfill({
        json: { state: "ready_empty", message: "No supported media was found." },
      });
    if (path.endsWith("/destinations")) return route.fulfill({ json: { destinations: [] } });
    if (path.endsWith("/batches")) return route.fulfill({ json: { items: [] } });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "VideoCutlist access" })).toBeVisible();
  await page.getByLabel("Access token", { exact: true }).fill("wrong-token");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.getByRole("alert")).toContainText("not accepted");
  await page.getByLabel("Access token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.getByRole("region", { name: "Media library status" })).toContainText(
    "No supported media was found.",
  );
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    token,
  );
  expect(page.url()).not.toContain(token);
  await page.reload();
  await expect(page.getByRole("heading", { name: "VideoCutlist access" })).toBeVisible();
});
