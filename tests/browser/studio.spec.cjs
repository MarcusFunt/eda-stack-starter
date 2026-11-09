const { test, expect } = require("@playwright/test");

const sandboxDigest = "sha256:" + "a".repeat(64);

async function stubStudioApi(page) {
  await page.route("**/api/v1/health", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    json: {
      schema_version: 1,
      service: "eda-studio-api",
      status: "ok",
      api_version: "v1",
      build_version: "0.1.0",
    },
  }));
  await page.route("**/api/v1/toolchain", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    json: {
      schema_version: 1,
      checked_at_utc: "2026-11-09T10:00:00Z",
      tools: {
        python: { status: "available", version: "3.11.4" },
        node: { status: "available", version: "v24.15.0" },
        ngspice: { status: "unavailable", reason: "Executable was not found." },
        kicad_cli: { status: "unavailable", reason: "Executable was not found." },
        docker: { status: "available", version: "29.9.2" },
        tscircuit_worker: { status: "available", version: "0.1.0" },
        tscircuit_sandbox: { status: "available", version: sandboxDigest },
      },
    },
  }));
}

test("Studio starts and reports tool availability from the local API", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await stubStudioApi(page);
  await page.goto("http://127.0.0.1:5173");

  await expect(page).toHaveTitle(/EDA Studio/);
  await expect(page.getByRole("link", { name: "EDA Studio home" })).toBeVisible();
  await expect(page.getByText("Local API connected")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Design workspace" })).toBeVisible();
  await expect(page.getByRole("listitem", { name: /ngspice.*Unavailable/i })).toBeVisible();
  await expect(page.getByRole("listitem", { name: /KiCad CLI.*Unavailable/i })).toBeVisible();
  await expect(page.getByRole("listitem", { name: /Pinned sandbox.*Available/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Compile" })).toBeDisabled();
  expect(pageErrors).toEqual([]);
});

test("narrow layout opens the project navigation and toolchain inspector as drawers", async ({ page }) => {
  await stubStudioApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:5173");

  const navigation = page.getByRole("navigation", { name: "Project navigation" });
  await expect(navigation).toBeHidden();
  await page.getByRole("button", { name: "Open project navigation" }).click();
  await expect(navigation).toBeVisible();

  const inspector = page.getByRole("complementary", { name: "Toolchain inspector" });
  await expect(inspector).toBeHidden();
  await page.getByRole("button", { name: "Open toolchain inspector" }).click();
  await expect(inspector).toBeVisible();
});

test("unreachable local API reports unknown tool status instead of unavailable", async ({ page }) => {
  await page.route("**/api/v1/**", route => route.abort());
  await page.goto("http://127.0.0.1:5173");

  await expect(page.getByText("Local API offline")).toBeVisible();
  await expect(page.getByText("Toolchain status is unknown because the local API could not be reached.")).toBeVisible();
  await expect(page.getByRole("listitem", { name: /ngspice.*Unavailable/i })).toHaveCount(0);
});
