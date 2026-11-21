import { expect, test, type Page } from "@playwright/test";

// Run against a real API + frontend, with public connected nodes and one saved
// path seeded beforehand. No API responses or model bytes are mocked here.
// This test verifies transport/rendering; its input GLB provenance must be
// recorded separately before claiming a real reconstruction acceptance test.
const publicUrl = process.env.TEST_SPACE_URL;
const savedPathId = process.env.TEST_SAVED_PATH_ID;
const privateUrl = process.env.TEST_PRIVATE_SPACE_URL;

test.use({ viewport: { width: 1280, height: 900 }, launchOptions: {
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
} });
test.setTimeout(90_000);

async function ready(page: Page) {
  await expect(page.getByRole("heading", { name: "Find a route" })).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByText("Downloading and building the 3D view…")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("public GLB supports dynamic and saved routes, orbit, and isolated sharing", async ({ page, browser }, info) => {
  if (!publicUrl || !savedPathId || !privateUrl) {
    throw new Error("Set TEST_SPACE_URL, TEST_SAVED_PATH_ID, and TEST_PRIVATE_SPACE_URL to seeded API resources.");
  }
  const errors: string[] = [];
  const downloads: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    // Signed-out current-user discovery intentionally returns 401. Chromium logs
    // that response as a resource error even though the app handles it normally.
    const expectedGuest = message.location().url.includes("/api/users/me") && message.text().includes("401");
    if (message.type() === "error" && !expectedGuest) errors.push(message.text());
  });
  page.on("response", response => {
    if (/\/api\/scans\/[^/]+\/file$/.test(new URL(response.url()).pathname) && response.ok()) downloads.push(response.url());
  });
  await page.goto(publicUrl);
  await ready(page);
  expect(downloads.length, "At least one authorized uploaded GLB must actually download").toBeGreaterThan(0);

  const start = page.getByRole("combobox", { name: "Start", exact: true });
  const destination = page.getByRole("combobox", { name: "Destination", exact: true });
  await start.selectOption(process.env.TEST_START_NODE_ID ?? { index: 1 });
  await destination.selectOption(process.env.TEST_END_NODE_ID ?? { index: 2 });
  await page.getByRole("button", { name: "Show route", exact: true }).click();
  await expect(page.getByText(/\d+ connected segments/)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("dynamic-route.png"), fullPage: true });

  if (process.env.TEST_START_NODE_ID && process.env.TEST_END_NODE_ID) {
    await start.selectOption(process.env.TEST_END_NODE_ID);
    await destination.selectOption(process.env.TEST_START_NODE_ID);
    await page.getByRole("button", { name: "Show route", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("not connected");
    await start.selectOption(process.env.TEST_START_NODE_ID);
    await destination.selectOption(process.env.TEST_END_NODE_ID);
    await page.getByRole("button", { name: "Show route", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  }

  const graph = page.getByRole("checkbox", { name: "Show navigation graph", exact: true });
  await graph.uncheck(); await expect(graph).not.toBeChecked();
  await graph.check(); await expect(graph).toBeChecked();
  const canvas = page.locator("canvas");
  const initialView = await canvas.screenshot();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.55, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => Buffer.compare(initialView, await canvas.screenshot())).not.toBe(0);
  await page.getByRole("button", { name: "Reset view", exact: true }).click();

  await page.getByRole("combobox", { name: "Saved route", exact: true }).selectOption(savedPathId);
  await expect(page.getByText(/\d+ connected segments/)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("saved-route.png"), fullPage: true });
  expect(errors, "The public viewer must not log JavaScript, GLB, or WebGL errors").toEqual([]);

  // A new browser context has no cookies, local storage, or inherited login.
  const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const second = await guest.newPage();
    const link = new URL(publicUrl); link.searchParams.set("path", savedPathId);
    await second.goto(link.toString());
    await ready(second);
    await expect(second.getByText(/\d+ connected segments/)).toBeVisible();
    await second.screenshot({ path: info.outputPath("second-session-mobile.png"), fullPage: true });

    if (process.env.TEST_EVENT_URL) {
      await second.goto(process.env.TEST_EVENT_URL);
      await second.locator(`a[href*="path=${savedPathId}"]`).click();
      await ready(second);
      await expect(second.getByText(/\d+ connected segments/)).toBeVisible();
    }

    await second.goto(privateUrl);
    await expect(second.getByRole("alert")).toContainText("unavailable or private");
    await expect(second.locator("canvas")).toHaveCount(0);
    const privateApi = new URL(privateUrl);
    privateApi.pathname = privateApi.pathname.replace(/^\/spaces\//, "/api/spaces/");
    privateApi.search = "";
    const denied = await guest.request.get(privateApi.toString());
    expect([403, 404]).toContain(denied.status());
    if (process.env.TEST_PRIVATE_SCAN_ID) {
      const rawFile = new URL(`/api/scans/${encodeURIComponent(process.env.TEST_PRIVATE_SCAN_ID)}/file`, privateUrl);
      expect([403, 404]).toContain((await guest.request.get(rawFile.toString())).status());
    }
  } finally { await guest.close(); }
});
