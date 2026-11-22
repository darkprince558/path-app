import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests", testMatch: "navmesh.browser.spec.ts", workers: 1,
  use: { baseURL: "http://127.0.0.1:5186", launchOptions: {
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  } },
  webServer: { command: "pnpm dev --host 127.0.0.1 --port 5186 --strictPort", url: "http://127.0.0.1:5186", reuseExistingServer: false },
});
