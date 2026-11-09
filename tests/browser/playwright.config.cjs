const { defineConfig } = require("@playwright/test");
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
});
