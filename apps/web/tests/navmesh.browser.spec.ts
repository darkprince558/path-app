import { expect, test } from "@playwright/test";
import { PerspectiveCamera, Vector3 } from "three";

for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }]) {
  test(`NavMesh route, picking, overlay and unreachable states at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/navmesh-demo");
    await expect(page.getByRole("status")).toHaveText(/Route ready · 10\.71 m/);
    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();
    await canvas.scrollIntoViewIfNeeded();
    // Project an arbitrary floor point into the initial camera, then exercise actual ray picking.
    const bounds = (await canvas.boundingBox())!;
    const camera = new PerspectiveCamera(50, bounds.width / bounds.height, 0.1, 2000);
    camera.position.set(10, 15, 14); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const projected = new Vector3(-4, 0, 3).project(camera);
    await canvas.dblclick({ position: { x: (projected.x + 1) * bounds.width / 2, y: (1 - projected.y) * bounds.height / 2 } });
    await expect.poll(async () => Number(await page.getByLabel("Start x", { exact: true }).inputValue())).toBeCloseTo(-4, 1);
    await expect.poll(async () => Number(await page.getByLabel("Start z", { exact: true }).inputValue())).toBeCloseTo(3, 1);
    await expect(page.getByLabel("Set point")).toHaveValue("destination");
    await page.getByRole("button", { name: "Reset points" }).click();
    await expect(page.getByRole("status")).toHaveText(/Route ready/);
    await page.getByLabel("Show walkable overlay").uncheck();
    await expect(page.getByLabel("Show walkable overlay")).not.toBeChecked();
    await page.getByLabel("Show walkable overlay").check();
    await page.getByLabel("Close doorway").check();
    await expect(page.getByRole("alert")).toHaveText(/No complete route/);
    await page.getByLabel("Close doorway").uncheck();
    await expect(page.getByRole("status")).toHaveText(/Route ready/);
    await page.getByLabel("Destination x", { exact: true }).fill("100");
    await expect(page.getByRole("alert")).toHaveText(/inside a walkable region/);
    await page.getByRole("button", { name: "Reset points" }).click();
    await page.getByText("Agent clearance settings", { exact: true }).click();
    await page.getByLabel("Radius (m)", { exact: true }).fill("1.1");
    await page.getByRole("button", { name: "Rebuild NavMesh" }).click();
    await expect(page.getByRole("alert")).toHaveText(/No complete route/);
    await page.getByLabel("Radius (m)", { exact: true }).fill("0.3");
    await page.getByRole("button", { name: "Rebuild NavMesh" }).click();
    await expect(page.getByRole("status")).toHaveText(/Route ready/);
    await canvas.scrollIntoViewIfNeeded();
    // Give the WebGL renderer a pair of animation frames before the visual artifact.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: info.outputPath("navmesh-room.png"), fullPage: true });
    expect(errors).toEqual([]);
  });
}
