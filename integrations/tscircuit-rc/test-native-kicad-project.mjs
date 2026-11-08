import assert from "node:assert/strict";
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { rcSourceManifestGraph } from "./rc-source-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceTemplateDir = path.join(here, "kicad");
const nativeProject = await import("./native-kicad-project.mjs").catch(() => ({}));
const templateFiles = ["rc_filter.kicad_sch", "rc_filter.kicad_pcb", "rc_filter.kicad_pro", "sym-lib-table", "fp-lib-table"];

function source(resistance = "2.2k", capacitance = "47n") {
  return {
    design: { parameters: { resistance, capacitance } },
    sourceManifest: {
      ...rcSourceManifestGraph(),
      source_values: { resistance, capacitance },
      spice_components: [
        { name: "R1", nodes: ["NIN", "NOUT"], statement: `RR1 NIN NOUT ${resistance}` },
        { name: "C1", nodes: ["NOUT", "0"], statement: `CC1 NOUT 0 ${capacitance}` },
        {
          name: "simulation_voltage_source_0",
          nodes: ["NIN", "0"],
          statement: "Vsimulation_voltage_source_0 NIN 0 PULSE(0 5 0 1n 1n 1m 2m)",
        },
      ],
    },
  };
}

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "edastack-native-kicad-test-"));
}

async function copyTemplate(templateDir) {
  await mkdir(templateDir, { recursive: true });
  await Promise.all(templateFiles.map((file) => copyFile(path.join(sourceTemplateDir, file), path.join(templateDir, file))));
  return templateDir;
}

test("generates native KiCad values from the validated RC source", async () => {
  assert.equal(typeof nativeProject.buildNativeKicadProject, "function");
  const root = await temporaryDirectory();
  const templateDir = await copyTemplate(path.join(root, "template"));
  const outputDir = path.join(root, "generated");
  try {
    await nativeProject.buildNativeKicadProject({
      workspaceRoot: root,
      templateDir,
      outputDir,
      ...source("2.2k", "47n"),
    });
    const [schematic, board, files] = await Promise.all([
      readFile(path.join(outputDir, "rc_filter.kicad_sch"), "utf8"),
      readFile(path.join(outputDir, "rc_filter.kicad_pcb"), "utf8"),
      readdir(outputDir),
    ]);
    assert.match(schematic, /\(property "Reference" "R1"[\s\S]{0,240}\(property "Value" "2\.2k"/);
    assert.match(schematic, /\(property "Reference" "C1"[\s\S]{0,240}\(property "Value" "47n"/);
    assert.match(board, /\(property "Reference" "R1"[\s\S]{0,240}\(property "Value" "2\.2k"/);
    assert.match(board, /\(property "Reference" "C1"[\s\S]{0,240}\(property "Value" "47n"/);
    assert.deepEqual(files.sort(), [
      "fp-lib-table",
      "rc_filter.kicad_pcb",
      "rc_filter.kicad_pro",
      "rc_filter.kicad_sch",
      "sym-lib-table",
    ]);
    assert.match(await readFile(path.join(templateDir, "rc_filter.kicad_sch"), "utf8"), /\(property "Value" "1k"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unsupported SPICE component before emitting KiCad files", async () => {
  assert.equal(typeof nativeProject.buildNativeKicadProject, "function");
  const root = await temporaryDirectory();
  const templateDir = await copyTemplate(path.join(root, "template"));
  const outputDir = path.join(root, "generated");
  const input = source();
  input.sourceManifest.spice_components.push({
    name: "R2",
    nodes: ["NOUT", "0"],
    statement: "RR2 NOUT 0 1k",
  });
  try {
    await assert.rejects(
      nativeProject.buildNativeKicadProject({ workspaceRoot: root, templateDir, outputDir, ...input }),
      /component set|unsupported.*component/i,
    );
    await assert.rejects(readdir(outputDir), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects source manifest values that differ from the design parameters", async () => {
  assert.equal(typeof nativeProject.buildNativeKicadProject, "function");
  const root = await temporaryDirectory();
  const templateDir = await copyTemplate(path.join(root, "template"));
  const input = source();
  input.sourceManifest.source_values.resistance = "3k";
  try {
    await assert.rejects(
      nativeProject.buildNativeKicadProject({
        workspaceRoot: root,
        templateDir,
        outputDir: path.join(root, "generated"),
        ...input,
      }),
      /source value.*resistance|resistance.*source value/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a template that omits a source component value field", async () => {
  assert.equal(typeof nativeProject.buildNativeKicadProject, "function");
  const root = await temporaryDirectory();
  const malformedTemplate = path.join(root, "template");
  const outputDir = path.join(root, "generated");
  await copyTemplate(malformedTemplate);
  for (const file of templateFiles) {
    const contents = await readFile(path.join(sourceTemplateDir, file), "utf8");
    await writeFile(
      path.join(malformedTemplate, file),
      file === "rc_filter.kicad_sch"
        ? contents.replace('(property "Value" "1k"', '(property "Nominal" "1k"')
        : contents,
    );
  }
  try {
    await assert.rejects(
      nativeProject.buildNativeKicadProject({
        workspaceRoot: root,
        templateDir: malformedTemplate,
        outputDir,
        ...source(),
      }),
      /R1.*Value|Value.*R1/i,
    );
    await assert.rejects(readdir(outputDir), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects generated output that overlaps its source template", async () => {
  assert.equal(typeof nativeProject.buildNativeKicadProject, "function");
  const root = await temporaryDirectory();
  const templateDir = path.join(root, "template");
  await copyTemplate(templateDir);
  try {
    await assert.rejects(
      nativeProject.buildNativeKicadProject({
        workspaceRoot: root,
        templateDir,
        outputDir: templateDir,
        ...source(),
      }),
      /overlap|separate/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects generated output that traverses a template directory junction", async () => {
  assert.equal(typeof nativeProject.buildNativeKicadProject, "function");
  const root = await temporaryDirectory();
  const templateDir = await copyTemplate(path.join(root, "template"));
  const outputDir = path.join(root, "template-alias");
  symlinkSync(templateDir, outputDir, "junction");
  try {
    await assert.rejects(
      nativeProject.buildNativeKicadProject({
        workspaceRoot: root,
        templateDir,
        outputDir,
        ...source(),
      }),
      /symbolic link/i,
    );
    assert.match(await readFile(path.join(templateDir, "rc_filter.kicad_sch"), "utf8"), /\(property "Value" "1k"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replaces a hardlinked generated file without changing the reviewed template", async () => {
  assert.equal(typeof nativeProject.buildNativeKicadProject, "function");
  const root = await temporaryDirectory();
  const templateDir = await copyTemplate(path.join(root, "template"));
  const outputDir = path.join(root, "generated");
  await mkdir(outputDir);
  const templateSchematic = path.join(templateDir, "rc_filter.kicad_sch");
  const outputSchematic = path.join(outputDir, "rc_filter.kicad_sch");
  await link(templateSchematic, outputSchematic);
  const original = await readFile(templateSchematic, "utf8");
  try {
    await nativeProject.buildNativeKicadProject({
      workspaceRoot: root,
      templateDir,
      outputDir,
      ...source("2.2k", "47n"),
    });
    assert.equal(await readFile(templateSchematic, "utf8"), original);
    assert.match(await readFile(outputSchematic, "utf8"), /\(property "Reference" "R1"[\s\S]{0,240}\(property "Value" "2\.2k"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
