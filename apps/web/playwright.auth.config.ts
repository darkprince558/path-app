import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /(auth|events)\.browser\.spec\.ts/,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5190", viewport: { width: 1280, height: 800 } },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5190 --strictPort",
    url: "http://127.0.0.1:5190",
    reuseExistingServer: false,
  },
});
