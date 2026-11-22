import { expect, test, type Page } from "@playwright/test";
import { MathUtils, PerspectiveCamera, Sphere, Vector3 } from "three";
import { parseGlb } from "../src/lib/glb";
import { approvedMetadata, approvedTransform, roomGlb, spacePoint } from "./helpers/room-glb";

async function mockScan(page: Page, options: { closed?: boolean; noFloor?: boolean; unverified?: boolean; denied?: boolean; owner?: boolean; legacy?: boolean; upload?: boolean } = {}) {
  const bytes = roomGlb(options);
  let scanMetadata: Record<string, unknown> = options.legacy
    ? { alignmentVerified: true, coordinateSystem: { units: "relative", upAxis: "Y", calibrated: false } }
    : options.unverified ? {} : approvedMetadata;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (options.upload && path === "/api/scans" && route.request().method() === "POST") {
      expect(route.request().postDataBuffer()).toEqual(Buffer.from(bytes));
      return route.fulfill({ status: 201, json: { id: "scan", shareId: "room", sharePath: "/s/room", name: "New hallway" } });
    }
    if (path === "/api/scans/scan/calibration") { scanMetadata = approvedMetadata; return route.fulfill({ json: { scan: { metadata: scanMetadata } } }); }
    if (path === "/api/scans/scan" && route.request().method() === "PATCH") {
      scanMetadata = route.request().postDataJSON().metadata; return route.fulfill({ json: { scan: { metadata: scanMetadata } } });
    }
    if (options.denied) return route.fulfill({ status: 404, json: {} });
    if (path.endsWith("/asset") || path.endsWith("/file")) return route.fulfill({ contentType: "model/gltf-binary", body: Buffer.from(bytes) });
    if (path.endsWith("/cues")) return route.fulfill({ json: { cues: [] } });
    if (path === "/api/users/me") return route.fulfill(options.owner ? { json: { user: { id: "owner", displayName: "Owner" } } } : { status: 401, json: {} });
    if (path === "/api/paths") return route.fulfill({ json: { paths: [{ id: "saved", spaceId: "room", name: "Existing route" }] } });
    if (path === "/api/paths/saved") return route.fulfill({ json: { path: { id: "saved", spaceId: "room", waypoints: [{ nodeId: "a", sequence: 0 }, { nodeId: "b", sequence: 1 }] } } });
    if (path.endsWith("/graph")) return route.fulfill({ json: { spaceId: "room", nodes: [
      { id: "a", spaceId: "room", ...spacePoint({ x: -4, y: 0, z: -2 }) },
      { id: "b", spaceId: "room", ...spacePoint({ x: -4, y: 0, z: 3 }) },
    ], edges: [{ id: "edge", spaceId: "room", fromNodeId: "a", toNodeId: "b", distance: 5, bidirectional: true }], destinations: [] } });
    if (path.endsWith("/scans")) return route.fulfill({ json: { scans: [{ id: "scan", spaceId: "room", name: "Synthetic scan", sourceRevisionId: options.legacy ? "revision" : null, format: "glb", status: "ready", downloadPath: "/api/scans/scan/file", transform: approvedTransform, metadata: scanMetadata }] } });
    if (path === "/api/spaces/room") return route.fulfill({ json: { space: { id: "room", ownerId: "owner", name: "Doorway room", visibility: "public", boundary: { coordinateSystem: approvedMetadata.coordinateSystem } } } });
    return route.fulfill({ json: { shareId: "room", scanId: "scan", name: "Doorway room", format: "glb", assetPath: "/api/shares/room/asset", transform: approvedTransform, metadata: scanMetadata } });
  });
  const model = await parseGlb(bytes, approvedTransform), sphere = model.bounds.getBoundingSphere(new Sphere());
  model.dispose(); return sphere;
}
async function pick(page: Page, bounds: Sphere, p: { x: number; y: number; z: number }) {
  const canvas = page.locator("canvas"), rect = (await canvas.boundingBox())!;
  const camera = new PerspectiveCamera(55, rect.width / rect.height);
  const vertical = MathUtils.degToRad(55), horizontal = 2 * Math.atan(Math.tan(vertical / 2) * rect.width / rect.height);
  const distance = bounds.radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.1;
  camera.position.copy(bounds.center).add(new Vector3(0, distance * 0.4, distance * 0.92));
  camera.lookAt(bounds.center); camera.updateMatrixWorld();
  const screen = new Vector3(p.x, p.y, p.z).project(camera);
  await canvas.dblclick({ position: { x: (screen.x + 1) * rect.width / 2, y: (1 - screen.y) * rect.height / 2 } });
}
for (const width of [1280, 390]) {
  test(`shared approved GLB floor picking and debug at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const bounds = await mockScan(page);
    await page.goto("/s/room");
    await page.getByLabel("Automatic route", { exact: true }).check();
    await expect(page.getByRole("status")).toContainText("Walkable floor ready");
    await pick(page, bounds, spacePoint({ x: -4, y: 0, z: -2 }));
    await expect(page.getByRole("status")).toContainText("Start selected");
    await pick(page, bounds, spacePoint({ x: 4, y: 0, z: -2 }));
    await expect(page.getByRole("status")).toContainText(/Route ready · 10\.\d+ m/);
    await page.getByLabel("Show NavMesh debug").check();
    await expect.poll(async () => {
      const png = (await page.locator("canvas").screenshot()).toString("base64");
      return page.evaluate(async data => {
        const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, image.width, image.height).data;
        let green = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1]! > pixels[i]! + 20 && pixels[i + 1]! > pixels[i + 2]! + 5) green++;
        return green;
      }, png);
    }).toBeGreaterThan(500);
    await page.screenshot({ path: info.outputPath("approved-glb-route.png") });
    await page.getByLabel("Show NavMesh debug").uncheck();
    await page.getByRole("button", { name: "Set destination", exact: true }).click();
    await pick(page, bounds, spacePoint({ x: -2.4, y: 1.5, z: 0.5 }));
    // A disconnected obstacle top must never preserve the earlier successful route.
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText(/Route ready/)).toHaveCount(0);
    await page.getByRole("switch", { name: "Avoid stairs" }).click();
    await expect(page.getByRole("status")).toContainText("Walkable floor ready");
    await page.getByLabel("Automatic route", { exact: true }).uncheck();
    await page.getByLabel("Automatic route", { exact: true }).check();
    await expect(page.getByRole("status")).toContainText("Walkable floor ready");
    await page.getByLabel("Automatic route", { exact: true }).uncheck();
    expect(errors).toEqual([]);
  });
}
test("space manual and saved routes survive automatic mode", async ({ page }) => {
  await mockScan(page); await page.goto("/spaces/room?path=saved");
  await expect(page.getByText("1 connected segments")).toBeVisible();
  await page.getByLabel("Automatic route", { exact: true }).check();
  await expect(page.getByRole("status")).toContainText("Walkable floor ready");
  await expect(page.getByLabel("Saved route")).toBeHidden();
  await page.getByLabel("Automatic route", { exact: true }).uncheck();
  await expect(page.getByLabel("Saved route")).toHaveValue("saved");
  await expect(page.getByText("1 connected segments")).toBeVisible();
});
test("no floor, disconnected doorway, relative coordinates and denied shares", async ({ page }) => {
  const bounds = await mockScan(page, { closed: true }); await page.goto("/s/room");
  await page.getByLabel("Automatic route", { exact: true }).check();
  await expect(page.getByRole("status")).toContainText("Walkable floor ready");
  await pick(page, bounds, spacePoint({ x: -4, y: 0, z: -2 }));
  await pick(page, bounds, spacePoint({ x: 4, y: 0, z: -2 }));
  await expect(page.getByRole("alert")).toContainText("No complete route");
  await page.unroute("**/api/**"); await mockScan(page, { noFloor: true }); await page.reload();
  await page.getByLabel("Automatic route", { exact: true }).check();
  await expect(page.getByRole("alert")).toContainText(/continuous floor/);
  await expect(page.locator("canvas")).toBeVisible();
  await page.unroute("**/api/**"); await mockScan(page, { legacy: true }); await page.reload();
  await expect(page.getByLabel("Automatic route", { exact: true })).toBeDisabled();
  await page.unroute("**/api/**"); await mockScan(page, { denied: true }); await page.reload();
  await expect(page.getByRole("heading", { name: "This link isn't open to you" })).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(0);
});


test("owner restores legacy LiDAR calibration without SQL or alignment checkboxes", async ({ page }) => {
  await mockScan(page, { owner: true, legacy: true }); await page.goto("/spaces/room");
  await expect(page.getByLabel("Automatic route", { exact: true })).toBeDisabled();
  await page.getByText("Owner tools", { exact: true }).click();
  await page.getByText("Upload and align scans", { exact: true }).click();
  await page.getByLabel("Scan", { exact: true }).selectOption("scan");
  const request = page.waitForRequest(r => r.url().endsWith("/api/scans/scan/calibration"));
  await page.getByRole("button", { name: "Restore validated LiDAR calibration" }).click();
  expect((await request).method()).toBe("POST");
  expect((await request).postDataJSON()).toEqual({});
  await expect(page.getByLabel("Automatic route", { exact: true })).toBeEnabled();
  await page.getByLabel("Automatic route", { exact: true }).check();
  await expect(page.getByRole("status").filter({ hasText: "Walkable floor ready" })).toBeVisible();
});

test("owner alignment confirmation alone cannot calibrate an imported model", async ({ page }) => {
  await mockScan(page, { owner: true, unverified: true }); await page.goto("/spaces/room");
  await page.getByText("Owner tools", { exact: true }).click();
  await page.getByText("Upload and align scans", { exact: true }).click();
  await page.getByLabel("Scan", { exact: true }).selectOption("scan");
  await expect(page.getByRole("button", { name: "Restore validated LiDAR calibration" })).toHaveCount(0);
  await page.getByLabel(/I verified the floor is Y-up/).check();
  const patch = page.waitForRequest(r => r.url().endsWith("/api/scans/scan") && r.method() === "PATCH");
  await page.getByRole("button", { name: "Save alignment confirmation" }).click();
  expect((await patch).postDataJSON().metadata.coordinateSystem.calibrated).toBe(false);
  await expect(page.getByLabel("Automatic route", { exact: true })).toBeDisabled();
  await page.getByLabel(/I independently verified this scan's metric scale/).check();
  await page.getByRole("button", { name: "Save alignment confirmation" }).click();
  await expect(page.getByLabel("Automatic route", { exact: true })).toBeEnabled();
});

for (const width of [1280, 390]) {
  test(`fresh upload can route without calibration or an extra mode toggle at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const bounds = await mockScan(page, { owner: true, unverified: true, upload: true });
    await page.goto("/maps/new");
    await page.locator('input[type="file"]').setInputFiles({ name: "Hallway.glb", mimeType: "model/gltf-binary", buffer: Buffer.from(roomGlb()) });
    await page.getByRole("button", { name: "Upload and get link" }).click();
    await page.getByRole("link", { name: "Plan a route", exact: true }).click();
    await expect(page.getByLabel("Automatic route", { exact: true })).toBeChecked();
    await expect(page.getByRole("status")).toContainText("Walkable floor ready");
    await expect(page.getByText(/Scale is unverified/)).toBeVisible();
    await pick(page, bounds, spacePoint({ x: -4, y: 0, z: -2 }));
    await pick(page, bounds, spacePoint({ x: 4, y: 0, z: -2 }));
    await expect(page.getByRole("status")).toContainText(/Route ready · ≈ 10\.\d+ m/);
    await page.getByText("Step-by-step directions", { exact: true }).click();
    await expect(page.getByRole("list", { name: "Route directions" })).toContainText("Arrive at your destination");
    await page.getByText("Step-by-step directions", { exact: true }).click();
    await page.screenshot({ path: info.outputPath("upload-autopath.png") });
    await page.getByRole("button", { name: "Clear route" }).click();
    await expect(page.getByRole("status")).toContainText("Walkable floor ready");
    await expect(page.getByRole("list", { name: "Route directions" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
