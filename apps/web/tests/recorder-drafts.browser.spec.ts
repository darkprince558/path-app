import { expect, test, type Page } from "@playwright/test";

// Run against the built web app. Chromium's synthetic camera feeds the real
// MediaRecorder. Only the ready-job response is stubbed in this storage test.
const url = process.env.TEST_RECORDER_URL;
test.use({ permissions: ["camera"], launchOptions: {
  executablePath: process.env.TEST_CHROME_EXECUTABLE,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
} });

async function record(page: Page) {
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByText("00:01", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Stop recording" }).click();
  await expect(page.getByRole("button", { name: "Discard take" })).toBeVisible();
  return page.evaluate(() => sessionStorage.getItem("path.recorder.take"));
}

test("a stale recorder tab keeps its own draft and cannot discard a newer tab's take or job", async ({ context }) => {
  if (!url) throw new Error("Set TEST_RECORDER_URL to the recorder's /record route.");
  const older = await context.newPage();
  const newer = await context.newPage();
  const entry = new URL(url); entry.hash = "key=test-recorder";
  for (const tab of [older, newer]) {
    await tab.goto(entry.href);
    await expect(tab.getByRole("button", { name: "Start recording" })).toBeEnabled();
  }
  const a = await record(older);
  const b = await record(newer);
  expect(a).toBeTruthy(); expect(b).toBeTruthy(); expect(b).not.toBe(a);
  await older.reload();
  await expect(older.getByRole("button", { name: "Discard take" })).toBeVisible();
  expect(await older.evaluate(() => sessionStorage.getItem("path.recorder.take"))).toBe(a);

  const status = { status: "ready", sharePath: "/s/recording-test" };
  await context.route("**/api/captures/" + b, (route) => route.fulfill({ json: status }));
  await newer.getByRole("button", { name: "Process on Mac" }).click();
  await expect(newer.getByRole("link", { name: "Open 3D scan" })).toBeVisible();
  older.once("dialog", (dialog) => dialog.accept());
  await older.getByRole("button", { name: "Discard take" }).click();
  await expect(older.getByRole("button", { name: "Start recording" })).toBeEnabled();

  for (const tab of [newer, await context.newPage()]) {
    await tab.goto(entry.href);
    await expect(tab.getByRole("link", { name: "Open 3D scan" })).toBeVisible();
    expect(await tab.evaluate(() => sessionStorage.getItem("path.recorder.take"))).toBe(b);
  }
});

test("a take survives reload when the browser cannot store native video blobs", async ({ page }) => {
  if (!url) throw new Error("Set TEST_RECORDER_URL to the recorder's /record route.");
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (value?.video instanceof Blob) throw new DOMException("Blob storage unavailable", "UnknownError");
      return put.call(this, value, key);
    };
  });
  const entry = new URL(url); entry.hash = "key=test-recorder";
  await page.goto(entry.href);
  await record(page);
  const video = () => page.locator("video").evaluate(async (el) => {
    const blob = await (await fetch(el.currentSrc || el.src)).blob();
    return { bytes: blob.size, type: blob.type };
  });
  const before = await video();
  expect(before.bytes).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Process on Mac" })).toBeVisible();
  expect(await video()).toEqual(before);
});
