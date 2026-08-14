import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    channel: "chrome",
    headless: true,
    acceptDownloads: true,
    baseURL: "http://localhost:4188",
  },
  webServer: {
    command: "npm run preview -- --port 4188 --strictPort",
    url: "http://localhost:4188",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});