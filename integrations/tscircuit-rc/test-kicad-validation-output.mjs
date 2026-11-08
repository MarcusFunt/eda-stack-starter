import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const outputModule = await import("./kicad-validation-output.mjs").catch(() => ({}));

test("clears stale success summary and reports before a new KiCad validation run", async () => {
  assert.equal(typeof outputModule.prepareKicadValidationOutput, "function");
  const root = await mkdtemp(path.join(os.tmpdir(), "edastack-kicad-output-test-"));
  const reportsDir = path.join(root, "reports");
  const generatedDir = path.join(root, "generated");
  try {
    await mkdir(path.join(reportsDir, "fabrication", "gerbers"), { recursive: true });
    await mkdir(path.join(reportsDir, "spice-source"), { recursive: true });
    await mkdir(generatedDir, { recursive: true });
    await writeFile(path.join(reportsDir, "summary.json"), '{"status":"passed"}\n');
    await writeFile(path.join(reportsDir, "erc.json"), '{"old":"report"}\n');
    await writeFile(path.join(reportsDir, "fabrication", "gerbers", "old.gbr"), "old output\n");
    await writeFile(path.join(reportsDir, "spice-source", "source-to-spice-manifest.json"), "stale source\n");
    await writeFile(path.join(generatedDir, "rc_filter.kicad_sch"), "old project\n");

    const result = await outputModule.prepareKicadValidationOutput(reportsDir, generatedDir);

    assert.equal(result.fabricationDir, path.join(reportsDir, "fabrication"));
    for (const staleFile of ["summary.json", "erc.json"]) {
      await assert.rejects(access(path.join(reportsDir, staleFile)), { code: "ENOENT" });
    }
    await assert.rejects(access(path.join(reportsDir, "spice-source")), { code: "ENOENT" });
    await assert.rejects(access(path.join(reportsDir, "fabrication", "gerbers", "old.gbr")), { code: "ENOENT" });
    await assert.rejects(access(path.join(generatedDir, "rc_filter.kicad_sch")), { code: "ENOENT" });
    assert.deepEqual((await readdir(result.fabricationDir)).sort(), ["drill", "gerbers"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
