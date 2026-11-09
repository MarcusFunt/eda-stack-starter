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
  await page.route("**/api/v1/projects", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    json: {
      schema_version: 1,
      workspace_status: "available",
      workspace_name: "fixtures",
      projects: [{ project_id: "voltage-divider", name: "Voltage Divider", entrypoint: "src/board.tsx", source_file_count: 1 }],
    },
  }));
  await page.route("**/api/v1/projects/voltage-divider", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    json: {
      schema_version: 1,
      project_id: "voltage-divider",
      name: "Voltage Divider",
      entrypoint: "src/board.tsx",
      source_file_count: 1,
      source_files: [{ path: "src/board.tsx", bytes: 32 }],
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

test("malformed toolchain JSON is reported as unknown status", async ({ page }) => {
  await page.route("**/api/v1/health", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    json: { schema_version: 1, service: "eda-studio-api", status: "ok", api_version: "v1", build_version: "0.1.0" },
  }));
  await page.route("**/api/v1/toolchain", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    json: { schema_version: 1, checked_at_utc: "not-a-time", tools: { ngspice: { status: "available" } } },
  }));
  await page.route("**/api/v1/projects", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    json: { schema_version: 1, workspace_status: "not_configured", projects: [] },
  }));
  await page.goto("http://127.0.0.1:5173");

  await expect(page.getByRole("status").filter({ hasText: "Toolchain status is unknown" })).toContainText("invalid toolchain response");
  await expect(page.getByRole("listitem", { name: /ngspice.*Available/i })).toHaveCount(0);
});

test("selecting and compiling a project shows the real build identity and unresolved parts", async ({ page }) => {
  let compileAuthorization;
  await stubStudioApi(page);
  await page.route("**/api/v1/session", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    json: { schema_version: 1, session_token: "local-session-token-with-more-than-32-characters" },
  }));
  await page.route("**/api/v1/projects/voltage-divider/compile", async route => {
    compileAuthorization = route.request().headers().authorization;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        schema_version: 1,
        status: "compiled",
        project_name: "Voltage Divider",
        project_id: "voltage-divider",
        entrypoint: "src/board.tsx",
        created_at_utc: "2026-11-09T12:00:00Z",
        source_files: [{ path: "src/board.tsx", sha256: "a".repeat(64), bytes: 32 }],
        source_graph_counts: { components: 3, ports: 7, nets: 3 },
        toolchain: {
          node: "v24.15.0", tscircuit: "0.0.3114", react: "19.3.1", compiler_runtime: "0.1.0",
          compiler_lock_sha256: "b".repeat(64), sandbox_image: sandboxDigest,
          circuit_json_to_kicad: "0.0.270", worker: "0.1.0",
        },
        circuit_json_sha256: "c".repeat(64),
        source_graph_sha256: "d".repeat(64),
        parts_verification: { status: "unverified", unresolved: 3, sha256: "e".repeat(64) },
        kicad_export_files: ["kicad/voltage-divider.kicad_sch"],
        artifacts: {
          "circuit.json": { sha256: "c".repeat(64), bytes: 1024 },
          "source-graph.json": { sha256: "d".repeat(64), bytes: 512 },
          "kicad/voltage-divider.kicad_sch": { sha256: "f".repeat(64), bytes: 4096 },
        },
        build_id: "1234567890abcdef1234567890abcdef",
        manifest_sha256: "1".repeat(64),
      },
    });
  });
  await page.goto("http://127.0.0.1:5173");

  await page.getByRole("button", { name: /Open Voltage Divider project/i }).click();
  await expect(page.getByRole("button", { name: "Compile", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Compile", exact: true }).click();

  await expect(page.locator(".build-report-heading h2")).toHaveText("Build 1234567890abcdef1234567890abcdef");
  await expect(page.getByText("3 components · 7 ports · 3 nets")).toBeVisible();
  await expect(page.getByText("Parts unverified · 3 unresolved")).toBeVisible();
  await expect(page.getByText(`Sandbox ${sandboxDigest}`)).toBeVisible();
  await expect(page.getByText(`Compiler lock SHA-256 ${"b".repeat(64)}`)).toBeVisible();
  await expect(page.getByText("circuit.json")).toBeVisible();
  expect(compileAuthorization).toBe("Bearer local-session-token-with-more-than-32-characters");
});

test("compile failures remain visible and do not show a compiled build", async ({ page }) => {
  await stubStudioApi(page);
  await page.route("**/api/v1/session", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    json: { schema_version: 1, session_token: "local-session-token-with-more-than-32-characters" },
  }));
  await page.route("**/api/v1/projects/voltage-divider/compile", route => route.fulfill({
    status: 422,
    contentType: "application/json",
    json: {
      schema_version: 1,
      error: {
        code: "BUILD_FAILED",
        message: "The sandboxed compiler could not compile this project.",
        request_id: "a".repeat(32),
        details: ["TSCIRCUIT_COMPILE_ERROR"],
      },
    },
  }));
  await page.goto("http://127.0.0.1:5173");

  await page.getByRole("button", { name: /Open Voltage Divider project/i }).click();
  await page.getByRole("button", { name: "Compile", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText("The sandboxed compiler could not compile this project.");
  await expect(page.getByRole("alert")).toContainText("TSCIRCUIT_COMPILE_ERROR");
  await expect(page.getByText(/Build [a-f0-9]{32}/)).toHaveCount(0);
});

test("toolchain refresh is independent and keeps the selected project open", async ({ page }) => {
  let toolchainReads = 0;
  let refreshRequested = false;
  await stubStudioApi(page);
  await page.route("**/api/v1/toolchain", route => {
    toolchainReads += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        schema_version: 1,
        checked_at_utc: refreshRequested ? "2026-11-09T11:00:00Z" : "2026-11-09T10:00:00Z",
        tools: { python: { status: "available", version: "3.11.4" } },
      },
    });
  });
  await page.goto("http://127.0.0.1:5173");
  await page.getByRole("button", { name: /Open Voltage Divider project/i }).click();
  await expect(page.getByText(/Checked .*10:00.*UTC/)).toBeVisible();
  refreshRequested = true;
  await page.getByRole("button", { name: "Refresh toolchain status" }).click();

  await expect(page.getByText(/Checked .*11:00.*UTC/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Compile", exact: true })).toBeEnabled();
  expect(toolchainReads).toBeGreaterThan(2);
});

test("activity tabs have linked panels and support arrow-key navigation", async ({ page }) => {
  await stubStudioApi(page);
  await page.goto("http://127.0.0.1:5173");

  const problems = page.getByRole("tab", { name: /Problems/ });
  await expect(problems).toHaveAttribute("aria-controls", "activity-panel");
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "activity-tab-problems");
  await problems.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Jobs" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Jobs" })).toHaveAttribute("aria-selected", "true");
});

test("small viewports do not overflow and Escape closes mobile drawers", async ({ page }) => {
  await stubStudioApi(page);
  await page.goto("http://127.0.0.1:5173");

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 900, height: 800 },
    { width: 390, height: 600 },
    { width: 320, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    }));
    expect(dimensions.width).toBe(dimensions.innerWidth);
    expect(dimensions.height).toBe(dimensions.innerHeight);
  }

  const navigation = page.getByRole("navigation", { name: "Project navigation" });
  await page.getByRole("button", { name: "Open project navigation" }).click();
  await expect(navigation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(navigation).toBeHidden();

  const inspector = page.getByRole("complementary", { name: "Toolchain inspector" });
  await page.getByRole("button", { name: "Open toolchain inspector" }).click();
  await expect(inspector).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inspector).toBeHidden();
});
