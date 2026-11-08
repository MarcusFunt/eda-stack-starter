import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseDesignSource } from "./design-contract.mjs";

export async function buildSpiceSourceManifest({ sourceScript, outputDir, design }) {
  assert.ok(typeof sourceScript === "string" && sourceScript.length > 0, "tscircuit source builder script is required");
  assert.ok(typeof outputDir === "string" && outputDir.length > 0, "SPICE source output directory is required");
  const parameters = parseDesignSource({ schema_version: 1, parameters: design?.parameters });
  const scriptPath = path.resolve(sourceScript);
  const destination = path.resolve(outputDir);
  const result = spawnSync(
    process.execPath,
    [scriptPath, parameters.resistance, parameters.capacitance, destination],
    {
      cwd: path.dirname(scriptPath),
      encoding: "utf8",
      stdio: "ignore",
      timeout: 120_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      "Could not rebuild the tscircuit-to-SPICE source manifest: " +
        (result.error?.message || "node exited with code " + result.status),
    );
  }
  return readFile(path.join(destination, "source-to-spice-manifest.json"), "utf8").then(JSON.parse);
}
