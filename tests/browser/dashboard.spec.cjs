const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const repo = path.resolve(__dirname, "../..");
const python = process.env.EDA_PYTHON || (process.platform === "win32"
  ? path.join(repo, ".venv", "Scripts", "python.exe") : "python3");
let fixtureRoot, pageUrl;

function writeJSON(file, object) {
  fs.writeFileSync(file, JSON.stringify(object, null, 2), "utf8");
}
function makeReport(runId, project, result, maxLimit, includeError = false) {
  const folder = path.join(fixtureRoot, runId);
  fs.mkdirSync(folder, { recursive: true });
  const netlist = path.join(folder, "input.cir");
  const log = path.join(folder, "simulator.log");
  const csv = path.join(folder, "waveform.csv");
  fs.writeFileSync(netlist, "* archived " + runId + "\nR1 IN OUT 1k\nC1 OUT 0 100n\n", "utf8");
  fs.writeFileSync(log, "Simulation evidence for " + runId + "\n", "utf8");
  const samples = ["time_s,v(out)"];
  for (let i = 0; i < 5000; i++) {
    samples.push(String(i / 1000000) + "," + String(i === 1017 ? 100 : Math.sin(i / 90)));
  }
  fs.writeFileSync(csv, samples.join("\n") + "\n", "utf8");
  const passed = result <= maxLimit;
  const report = {
    schema_version: 1, project, run_id: runId, passed, run_completed_at_utc: "2026-11-09T10:00:00Z",
    simulator_version: "ngspice 47",
    scenarios: [{
      scenario: "nominal", category: "temperature-corner", status: includeError ? "error" : (passed ? "pass" : "fail"),
      passed, parameters: { R: runId === "candidate" ? "3k" : "1k" },
      checks: [
        { id: "vout_peak", value: result, unit: "V", min: 0, max: maxLimit, passed },
        { id: "rms_current", value: 0.001, unit: "A", passed: true },
        ...(includeError ? [{ id: "missing_probe", value: null, unit: "V", passed: false, error: "Missing probe" }] : []),
      ],
      artifacts: { netlist, log, waveforms: [{ id: "startup", analysis: "tran", csv, signals: ["v(out)"] }] },
    }],
  };
  const reportPath = path.join(folder, "report.json");
  writeJSON(reportPath, report);
  return reportPath;
}

test.beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "edastack-browser-"));
  const reports = [
    makeReport("baseline", "sensor_board", 0.003, 0.01),
    makeReport("candidate", "sensor_board", 0.015, 0.01),
    makeReport("unrelated", "different_board", 0.002, 0.01, true),
  ];
  const output = path.join(fixtureRoot, "index.html");
  execFileSync(python, ["-c", "import sys; from edastack.cli import main; sys.exit(main(sys.argv[1:]))",
    "dashboard", ...reports, "--out", output], { cwd: repo, encoding: "utf8" });
  pageUrl = pathToFileURL(output).href;
});
test.afterAll(() => {
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(pageUrl);
  await expect(page.locator("#summary .metric")).toHaveCount(5);
  expect(errors).toEqual([]);
});

test("honest statuses, failure-first display, search and project filtering", async ({ page }) => {
  await expect(page.locator("#summary")).toContainText("Measured only");
  await expect(page.locator("#summary")).toContainText("3");
  await expect(page.locator("#checks tr").first()).toContainText("missing_probe");
  await expect(page.locator("#checks tr").nth(1)).toContainText("vout_peak");
  await expect(page.locator("#checks")).toContainText("Measured");
  await expect(page.locator("#checks")).toContainText("Passed");
  await expect(page.locator("#checks")).toContainText("Failed");
  await page.locator("#status-filter").selectOption("measured");
  await expect(page.locator("#checks tr")).toHaveCount(3);
  await expect(page.locator("#checks tr").first()).toContainText("rms_current");
  await page.locator("#status-filter").selectOption("all");
  await page.locator("#project-filter").selectOption("sensor_board");
  await expect(page.locator("#matrix tr")).toHaveCount(2);
  await page.locator("#search").fill("candidate");
  await expect(page.locator("#matrix tr")).toHaveCount(1);
  await expect(page.locator("#matrix tr").first()).toContainText("candidate");
  await page.locator("#clear-filters").click();
  await expect(page.locator("#matrix tr")).toHaveCount(3);
});

test("scenario metadata search keeps its measurements visible", async ({ page }) => {
  await page.locator("#search").fill("temperature-corner");
  await expect(page.locator("#matrix tr")).toHaveCount(3);
  await expect(page.locator("#checks tr")).toHaveCount(7);
  await page.locator("#search").fill("3k");
  await expect(page.locator("#matrix tr")).toHaveCount(1);
  await expect(page.locator("#checks tr")).toHaveCount(2);
});

test("comparison reports numeric deltas and rejects cross-project comparisons", async ({ page }) => {
  await expect(page.locator("#compare-note")).toContainText("1 matching scenarios");
  await expect(page.locator("#compare-table")).toContainText("vout_peak");
  await expect(page.locator("#compare-table")).toContainText("Failed");
  await page.locator("#compare-target").selectOption("2");
  await expect(page.locator("#compare-note")).toContainText("Comparison blocked");
  await expect(page.locator("#compare-table tr")).toHaveCount(0);
  const diffText = await page.locator("#diffs").innerText();
  expect(diffText).not.toContain("different_board");
  await page.locator("#compare-target").selectOption("1");
  await page.evaluate(() => { DATA.runs[1].scenarios[0].checks[0].unit = "A"; renderComparison(); });
  await expect(page.locator("#compare-table")).toContainText("Unit mismatch");
});

test("archived evidence is inspectable and links to original local artifacts", async ({ page }) => {
  await page.locator("#evidence-select").selectOption("1:0");
  await expect(page.locator("#evidence details")).toHaveCount(4);
  await page.locator("#evidence summary").filter({hasText:"Rendered SPICE netlist"}).click();
  await expect(page.locator("#evidence")).toContainText("R1 IN OUT 1k");
  const originals = page.locator("#evidence a", { hasText: "Open original file" });
  await expect(originals.first()).toHaveAttribute("href", /^file:/);
  await page.locator("#issues button").first().click();
  await expect(page.locator("#evidence-select")).toHaveValue("2:0");
});

test("actual Chrome canvas supports peak-preserving display, zoom, trace toggles and cursors", async ({ page }) => {
  const sampleStats = await page.evaluate(() => ({
    max: Math.max(...DATA.waveforms[0].y),
    count: DATA.waveforms[0].display_samples,
    source: DATA.waveforms[0].samples,
  }));
  expect(sampleStats.max).toBe(100);
  expect(sampleStats.count).toBeLessThanOrEqual(2000);
  expect(sampleStats.source).toBe(5000);
  const canvas = page.locator("#chart");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box.x + 200, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x + 600, box.y + 150, {steps: 5});
  await page.mouse.up();
  await expect(page.locator("#cursor-readout")).toContainText("Drag to zoom");
  const zoomRange = await page.evaluate(() => state.waveRange);
  expect(zoomRange[1] - zoomRange[0]).toBeLessThan(0.00499);
  await page.locator("#wave-reset").click();
  const fullRange = await page.evaluate(() => state.waveRange);
  expect(fullRange[1] - fullRange[0]).toBeGreaterThan(zoomRange[1] - zoomRange[0]);
  await canvas.click({position: {x:180, y:155}});
  await canvas.click({position: {x:450, y:155}});
  await expect(page.locator("#cursor-readout")).toContainText("Δt:");
  const checkboxes = page.locator("#legend input[type=checkbox]");
  const count = await checkboxes.count();
  for (let i = 0; i < count; i++) await checkboxes.nth(i).uncheck();
  await expect(page.locator("#cursor-readout")).toContainText("No visible traces");
  await checkboxes.first().check();
  await expect(page.locator("#cursor-readout")).toContainText("Cursor");
});
