import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1440, height: 1000 },
    launchOptions: { channel: "chrome" },
  },
  reporter: "list",
});
