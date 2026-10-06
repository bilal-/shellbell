import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./browser",
  testMatch: "**/*.spec.ts",
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:8795",
    viewport: { width: 390, height: 640 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 640 } },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 390, height: 640 } },
    },
  ],
  webServer: {
    command: "node scripts/serve-terminal-fixture.mjs",
    url: "http://127.0.0.1:8795",
    env: { SHELLBELL_TERMINAL_FIXTURE_PORT: "8795" },
    reuseExistingServer: false,
  },
});
