import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const contract = await import("./design-contract.mjs").catch(() => ({}));

test("design source accepts bounded SPICE literals and rejects injected text", () => {
  assert.equal(typeof contract.parseDesignSource, "function");
  assert.deepEqual(
    contract.parseDesignSource({
      schema_version: 1,
      parameters: { resistance: "1k", capacitance: "100n" },
    }),
    { resistance: "1k", capacitance: "100n" },
  );
  assert.throws(
    () => contract.parseDesignSource({
      schema_version: 1,
      parameters: { resistance: "1k; .control quit", capacitance: "100n" },
    }),
    /SPICE literal/,
  );
});

test("normalizes SPICE literals to finite numeric values for tscircuit", () => {
  assert.equal(typeof contract.spiceValueInBaseUnits, "function");
  assert.equal(typeof contract.toTscircuitNumericLiteral, "function");
  assert.equal(contract.spiceValueInBaseUnits("1e3"), 1000);
  assert.ok(Math.abs(contract.spiceValueInBaseUnits("100n") - 1e-7) <= 1e-20);
  assert.equal(contract.toTscircuitNumericLiteral("1e3"), "1000");
  assert.equal(contract.toTscircuitNumericLiteral("1e-7"), "0.0000001");
  assert.equal(contract.toTscircuitNumericLiteral("1meg"), "1000000");
  assert.throws(() => contract.spiceValueInBaseUnits("1e999"), /finite|SPICE literal/i);
});

test("candidate diff is limited to the reviewed source design file", () => {
  assert.equal(typeof contract.assertCandidateDiff, "function");
  assert.doesNotThrow(() =>
    contract.assertCandidateDiff(["integrations/tscircuit-rc/design.json"]),
  );
  for (const protectedPath of [
    "examples/rc_filter/spec.json",
    "models/library.json",
    "tests/test_core.py",
    "integrations/tscircuit-rc/verify.mjs",
  ]) {
    assert.throws(
      () => contract.assertCandidateDiff([protectedPath]),
      /only integrations\/tscircuit-rc\/design.json may change/,
    );
  }
  assert.throws(
    () => contract.assertCandidateDiff([
      "integrations/tscircuit-rc/design.json",
      "examples/rc_filter/spec.json",
    ]),
    /only integrations\/tscircuit-rc\/design.json may change/,
  );
});

test("candidate attempts stop at the configured iteration cap", () => {
  assert.equal(typeof contract.assertAttemptAvailable, "function");
  assert.doesNotThrow(() => contract.assertAttemptAvailable(2));
  assert.throws(() => contract.assertAttemptAvailable(3), /iteration limit/);
});

test("SPICE builder reads component values from the source design file", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "eda-p4-source-test-"));
  const fixtureDir = path.join(tempRoot, "integrations", "tscircuit-rc");
  try {
    await mkdir(fixtureDir, { recursive: true });
    for (const filename of ["build-spice.mjs", "design-contract.mjs", "package-lock.json"]) {
      await cp(path.join(here, filename), path.join(fixtureDir, filename));
    }
    const candidate = JSON.parse(await readFile(path.join(here, "design.json"), "utf8"));
    candidate.parameters.resistance = "3k";
    await writeFile(path.join(fixtureDir, "design.json"), `${JSON.stringify(candidate, null, 2)}\n`);
    await symlink(
      path.join(here, "node_modules"),
      path.join(fixtureDir, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = spawnSync(
      process.execPath,
      [path.join(fixtureDir, "build-spice.mjs")],
      { cwd: fixtureDir, encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const expectedOutput = path.join(tempRoot, "build", "tscircuit-rc", "r-3k-c-100n");
    const manifest = JSON.parse(
      await readFile(path.join(expectedOutput, "source-to-spice-manifest.json"), "utf8"),
    );
    assert.equal(manifest.source_values.resistance, "3k");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
