import assert from "node:assert/strict";
import { lstat, mkdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { assertPathsDisjoint } from "./workspace-path.mjs";

const REPORT_FILES = [
  "summary.json",
  "erc.json",
  "drc.json",
  "netlist.net",
  "board-stats.json",
  "board-preview.png",
];
const REPORT_TREES = ["fabrication", "spice-source"];
const GENERATED_FILES = [
  "rc_filter.kicad_pro",
  "rc_filter.kicad_sch",
  "rc_filter.kicad_pcb",
  "sym-lib-table",
  "fp-lib-table",
  "rc_filter.kicad_prl",
];

async function assertNoSymlinkTraversal(targetPath) {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      assert.equal(info.isSymbolicLink(), false, "KiCad output path must not traverse a symbolic link: " + current);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") break;
      throw error;
    }
  }
}

async function removeKnownFile(targetPath) {
  try {
    const info = await lstat(targetPath);
    assert.equal(info.isDirectory(), false, "Expected a generated file, found a directory: " + targetPath);
    await unlink(targetPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function removeKnownTree(targetPath) {
  try {
    await lstat(targetPath);
    await rm(targetPath, { recursive: true, force: false });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function prepareKicadValidationOutput(validationDir, generatedDir) {
  assert.ok(typeof validationDir === "string" && path.isAbsolute(validationDir), "KiCad validation directory must be absolute");
  assert.ok(typeof generatedDir === "string" && path.isAbsolute(generatedDir), "Generated KiCad directory must be absolute");
  const resolvedValidationDir = path.resolve(validationDir);
  const resolvedGeneratedDir = path.resolve(generatedDir);
  assertPathsDisjoint({ validation: resolvedValidationDir, generated: resolvedGeneratedDir });
  await Promise.all([
    assertNoSymlinkTraversal(resolvedValidationDir),
    assertNoSymlinkTraversal(resolvedGeneratedDir),
  ]);
  await mkdir(resolvedValidationDir, { recursive: true });

  await Promise.all([
    ...REPORT_FILES.map((name) => removeKnownFile(path.join(resolvedValidationDir, name))),
    ...REPORT_TREES.map((name) => removeKnownTree(path.join(resolvedValidationDir, name))),
    ...GENERATED_FILES.map((name) => removeKnownFile(path.join(resolvedGeneratedDir, name))),
  ]);

  const fabricationDir = path.join(resolvedValidationDir, "fabrication");
  await mkdir(path.join(fabricationDir, "gerbers"), { recursive: true });
  await mkdir(path.join(fabricationDir, "drill"), { recursive: true });
  return { fabricationDir, generatedDir: resolvedGeneratedDir };
}
