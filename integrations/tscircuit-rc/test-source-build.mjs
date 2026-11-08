import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceBuilder = await import("./source-build.mjs").catch(() => ({}));

test("builds the tscircuit Circuit JSON and SPICE manifest from source-design values", async () => {
  assert.equal(typeof sourceBuilder.buildSpiceSourceManifest, "function");
  const root = await mkdtemp(path.join(os.tmpdir(), "edastack-spice-source-test-"));
  const outputDir = path.join(root, "generated");
  try {
    const manifest = await sourceBuilder.buildSpiceSourceManifest({
      sourceScript: path.join(here, "build-spice.mjs"),
      outputDir,
      design: { parameters: { resistance: "2.2k", capacitance: "47n" } },
    });
    assert.deepEqual(manifest.source_values, { resistance: "2.2k", capacitance: "47n" });
    assert.match(manifest.spice_components.find((component) => component.name === "R1").statement, /2\.2k$/i);
    assert.match(manifest.spice_components.find((component) => component.name === "C1").statement, /47n$/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes exponent literals before passing values to tscircuit", async () => {
  assert.equal(typeof sourceBuilder.buildSpiceSourceManifest, "function");
  const root = await mkdtemp(path.join(os.tmpdir(), "edastack-spice-source-test-"));
  try {
    const manifest = await sourceBuilder.buildSpiceSourceManifest({
      sourceScript: path.join(here, "build-spice.mjs"),
      outputDir: path.join(root, "generated"),
      design: { parameters: { resistance: "1e3", capacitance: "1e-7" } },
    });
    assert.deepEqual(manifest.source_values, { resistance: "1e3", capacitance: "1e-7" });
    assert.match(manifest.spice_components.find((component) => component.name === "R1").statement, /1K$/i);
    assert.match(manifest.spice_components.find((component) => component.name === "C1").statement, /100N$/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid source design values before creating source artifacts", async () => {
  assert.equal(typeof sourceBuilder.buildSpiceSourceManifest, "function");
  const root = await mkdtemp(path.join(os.tmpdir(), "edastack-spice-source-test-"));
  const outputDir = path.join(root, "generated");
  try {
    await assert.rejects(
      sourceBuilder.buildSpiceSourceManifest({
        sourceScript: path.join(here, "build-spice.mjs"),
        outputDir,
        design: { parameters: { resistance: "1k; .control", capacitance: "100n" } },
      }),
      /resistance.*positive SPICE literal/i,
    );
    await assert.rejects(readdir(outputDir), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
