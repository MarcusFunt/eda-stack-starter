const { defineConfig } = require("@playwright/test");
const path = require("node:path");
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "**/*.spec.cjs",
  timeout: 20000,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    browserName: "chromium",
    channel: process.env.EDA_BROWSER_CHANNEL || "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort",
    cwd: path.resolve(__dirname, "../../apps/studio-web"),
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
