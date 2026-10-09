import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", testMatch: "**/*.pw.ts", workers: 1, timeout: 60000,
  use: { baseURL: "https://localhost", ignoreHTTPSErrors: true, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: "bun e2e/server.ts", url: "https://127.0.0.1/__test/health", ignoreHTTPSErrors: true, reuseExistingServer: false, timeout: 60000 },
});
