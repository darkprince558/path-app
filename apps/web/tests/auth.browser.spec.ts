import { expect, test, type Page } from "@playwright/test";

// Synthetic HTTP sessions exercise React behavior, not an Auth0 credential exchange.
const user = { id: "owner-uuid", displayName: "Sam Example" };
async function session(page: Page, status = 200) {
  await page.route("**/api/users/me", route => route.fulfill({ status, json: status === 200 ? { user } : { error: { message: "Signed out" } } }));
}

test("anonymous owner routes wait for identity and preserve the login destination", async ({ page }) => {
  let ownerCalls = 0;
  await session(page, 401);
  await page.route("**/api/scans/mine", route => { ownerCalls++; return route.fulfill({ json: { scans: [] } }); });
  for (const path of ["/maps", "/maps/new", "/maps/synthetic?tab=sharing"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Sign in to manage your maps" })).toBeVisible();
    const link = page.getByRole("main").getByRole("link", { name: "Sign in", exact: true });
    expect(new URL(await link.getAttribute("href") ?? "", "http://localhost").searchParams.get("returnTo")).toBe(path);
  }
  expect(ownerCalls).toBe(0);
});

test("session identity and same-origin cookies survive refresh; logout uses the backend", async ({ page, context }) => {
  await context.addCookies([{ name: "synthetic-session", value: "present", url: "http://127.0.0.1:5190", httpOnly: true }]);
  await page.route("**/api/users/me", route => {
    const signedIn = route.request().headers().cookie?.includes("synthetic-session=present");
    return route.fulfill({ status: signedIn ? 200 : 401, json: signedIn ? { user } : {} });
  });
  let mineCalls = 0;
  await page.route("**/api/scans/mine", route => {
    expect(route.request().headers().cookie).toContain("synthetic-session=present");
    expect(route.request().headers()["x-dev-user"]).toBeUndefined();
    expect(route.request().headers().authorization).toBeUndefined();
    mineCalls++;
    return route.fulfill({ json: { scans: [] } });
  });
  await page.route("**/api/scans/shared", route => route.fulfill({ json: { scans: [] } }));
  await page.goto("/maps");
  await expect(page.getByText(user.displayName).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText(user.displayName).first()).toBeVisible();
  await expect.poll(() => mineCalls).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("link", { name: "Sign out" }).first()).toHaveAttribute("href", "/auth/logout?returnTo=%2F");
  // Simulate the backend clearing its cookie, then a full-page return to the site.
  await context.clearCookies();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in to manage your maps" })).toBeVisible();
});

test("a 401 from owner data removes the protected page and offers sign in", async ({ page }) => {
  await session(page);
  await page.route("**/api/scans/mine", route => route.fulfill({ status: 401, json: {} }));
  await page.route("**/api/scans/shared", route => route.fulfill({ json: { scans: [] } }));
  await page.goto("/maps");
  await expect(page.getByRole("heading", { name: "Sign in to manage your maps" })).toBeVisible();
});

test("account failure offers retry while public discovery remains available", async ({ page }) => {
  await session(page, 503);
  await page.route("**/api/scans/public", route => route.fulfill({ json: { scans: [{ shareId: "public-map", sharePath: "/s/public-map", name: "Public corridor", updatedAt: new Date().toISOString() }] } }));
  await page.goto("/community");
  await expect(page.getByText("Public corridor")).toBeVisible();
  await page.goto("/maps");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await session(page);
  await page.route("**/api/scans/mine", route => route.fulfill({ json: { scans: [] } }));
  await page.route("**/api/scans/shared", route => route.fulfill({ json: { scans: [] } }));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText(user.displayName).first()).toBeVisible();
});

test("signed-out public spaces are independent of account discovery", async ({ page }) => {
  await session(page, 401);
  await page.route("**/api/spaces", route => route.fulfill({ json: { spaces: [{ id: "public-space", name: "Public hall", ownerId: user.id, visibility: "public", boundary: null }] } }));
  await page.goto("/spaces");
  await expect(page.getByRole("link", { name: "Public hall" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create space" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/auth/login?returnTo=%2Fspaces");
});

test("loading account never shows upload controls", async ({ page }) => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/users/me", async route => { await wait; await route.fulfill({ status: 401, json: {} }); });
  await page.goto("/maps/new");
  await expect(page.getByRole("main").getByRole("status")).toHaveText("Checking sign-in…");
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  release();
  await expect(page.getByRole("heading", { name: "Sign in to manage your maps" })).toBeVisible();
});


test("changing accounts in another tab reloads owner data on focus", async ({ page }) => {
  let active = user;
  await page.route("**/api/users/me", route => route.fulfill({ json: { user: active } }));
  await page.route("**/api/scans/mine", route => route.fulfill({ json: { scans: [{
    shareId: "synthetic-map", sharePath: "/s/synthetic-map", name: `${active.displayName} map`,
    format: "ply", visibility: "private", viewerIds: [], updatedAt: new Date().toISOString(),
  }] } }));
  await page.route("**/api/scans/shared", route => route.fulfill({ json: { scans: [] } }));
  await page.goto("/maps");
  await expect(page.getByText(`${user.displayName} map`, { exact: true })).toBeVisible();
  active = { id: "other-owner", displayName: "Another Owner" };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText(`${active.displayName} map`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${user.displayName} map`, { exact: true })).toHaveCount(0);
});

test("GLB upload preserves the scan edit ID for immediate sharing changes", async ({ page }) => {
  await session(page);
  const shareId = "fixture-share-id";
  const scanId = "fixture-scan-id";
  await page.route("**/api/scans?**", async route => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(new URL(request.url()).searchParams.get("visibility")).toBe("unlisted");
    expect(request.headers()["content-type"]).toBe("application/octet-stream");
    await route.fulfill({ status: 201, json: { id: scanId, shareId, sharePath: `/s/${shareId}`, name: "Hallway" } });
  });
  let patched = false;
  await page.route(`**/api/scans/${scanId}`, async route => {
    expect(route.request().method()).toBe("PATCH");
    expect(route.request().postDataJSON()).toEqual({ visibility: "private" });
    patched = true;
    await route.fulfill({ json: { scan: { id: scanId, shareId, name: "Hallway", visibility: "private" } } });
  });
  await page.goto("/maps/new");
  await page.locator('input[type="file"]').setInputFiles({ name: "Hallway.glb", mimeType: "model/gltf-binary", buffer: Buffer.from("glTFsynthetic") });
  await page.getByRole("button", { name: "Upload and get link", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your link is ready" })).toBeVisible();
  await page.getByRole("radio", { name: /Private/ }).check();
  await page.getByRole("button", { name: /Save/ }).click();
  await expect.poll(() => patched).toBe(true);
  await expect(page.getByText("Saved. This map is now Private.", { exact: false })).toBeVisible();
});
