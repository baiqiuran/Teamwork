import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4311",
    browserName: "chromium",
    channel: "msedge",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:4311/api/setup/status",
    reuseExistingServer: false,
    env: {
      PORT: "4311",
      DAILY_DATABASE_PATH: `data/e2e-${randomUUID()}.sqlite`,
      DAILY_SETUP_KEY: "browser-test-setup-key",
    },
  },
});
