import { defineConfig } from "@playwright/test";

const port = Number(process.env.NAVMESH_TEST_PORT ?? 5186);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests", testMatch: /(?:navmesh|scan-navigation)\.browser\.spec\.ts/, workers: 1,
  use: { baseURL, launchOptions: {
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  } },
  webServer: { command: `pnpm dev --host 127.0.0.1 --port ${port} --strictPort`, url: baseURL, reuseExistingServer: false },
});
