import { defineConfig, devices } from "@playwright/test";

const port = process.env.E2E_PORT ?? "3100";

export default defineConfig({
  testDir: "e2e",
  timeout: 6 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/start-stack.mjs",
    url: `http://localhost:${port}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
