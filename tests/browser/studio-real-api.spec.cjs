const { test, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const enabled = process.env.EDA_STUDIO_REAL_E2E === "1";
const apiPort = Number(process.env.EDA_STUDIO_TEST_API_PORT || "8766");

test.skip(!enabled, "real Studio compile journey runs in its Docker-enabled CI job");

test("real Studio API compiles voltage-divider and reports verified artifact metadata", async ({ page }) => {
  test.setTimeout(120_000);
  const repositoryRoot = path.resolve(__dirname, "../..");
  const fixtureRoot = path.join(repositoryRoot, "benchmarks", "fixtures", "voltage-divider");
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eda-studio-browser-"));
  const projectRoot = path.join(workspaceRoot, "voltage-divider");
  fs.cpSync(fixtureRoot, projectRoot, { recursive: true });

  const environment = {
    ...process.env,
    EDA_STUDIO_WORKSPACE_ROOT: workspaceRoot,
    EDA_STUDIO_ALLOWED_ORIGINS: "http://127.0.0.1:5173",
    PYTHONPATH: [path.join(repositoryRoot, "src"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
  const apiProcess = spawn(
    process.env.EDA_PYTHON || "python",
    ["-m", "uvicorn", "edastack.studio.api:app", "--host", "127.0.0.1", "--port", String(apiPort)],
    { cwd: repositoryRoot, env: environment, stdio: "ignore" },
  );

  async function waitForApi() {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (apiProcess.exitCode !== null) throw new Error(`Studio API exited with code ${apiProcess.exitCode}.`);
      try {
        const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) return;
      } catch {
        // The next bounded poll checks for API startup.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Studio API did not become ready within 20 seconds.");
  }

  try {
    await waitForApi();
    await page.goto("http://127.0.0.1:5173");
    await expect(page.getByRole("button", { name: /Open voltage-divider project/i })).toBeVisible();
    await page.getByRole("button", { name: /Open voltage-divider project/i }).click();
    await expect(page.getByRole("button", { name: "Compile", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Compile", exact: true }).click();

    await expect(page.locator(".build-report-heading h2")).toContainText("Build ", { timeout: 90_000 });
    await expect(page.getByText(/3 components · 7 ports · 3 nets/)).toBeVisible();
    await expect(page.getByText(/Parts unverified · 3 unresolved/)).toBeVisible();
    await expect(page.getByText("circuit.json", { exact: true })).toBeVisible();
    await expect(page.getByText("source-graph.json", { exact: true })).toBeVisible();
    await expect(page.getByText("Compiled · not verified")).toBeVisible();
  } finally {
    apiProcess.kill();
    await new Promise((resolve) => {
      if (apiProcess.exitCode !== null) resolve();
      else apiProcess.once("exit", resolve);
      setTimeout(resolve, 5_000);
    });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
