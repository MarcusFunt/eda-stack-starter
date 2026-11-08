import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { validateManufacturingExports } from "./manufacturing-exports.mjs";

const gerbers = [
  ["rc_filter-F_Cu.gbr", "%TF.FileFunction,Copper,L1,Top*%"],
  ["rc_filter-B_Cu.gbr", "%TF.FileFunction,Copper,L2,Bot*%"],
  ["rc_filter-F_Mask.gbr", "%TF.FileFunction,Soldermask,Top*%"],
  ["rc_filter-B_Mask.gbr", "%TF.FileFunction,Soldermask,Bot*%"],
  ["rc_filter-F_Paste.gbr", "%TF.FileFunction,Paste,Top*%"],
  ["rc_filter-F_Silkscreen.gbr", "%TF.FileFunction,Legend,Top*%"],
  ["rc_filter-Edge_Cuts.gbr", "%TF.FileFunction,Profile,NP*%"],
];

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "edastack-manufacturing-test-"));
  const gerberDir = path.join(root, "gerbers");
  const drillDir = path.join(root, "drill");
  await mkdir(gerberDir);
  await mkdir(drillDir);
  for (const [name, fileFunction] of gerbers) {
    const layerData = name === "rc_filter-Edge_Cuts.gbr"
      ? "X0Y0D02*\nX14000000Y0D01*\nX14000000Y8000000D01*\nX0Y8000000D01*\nX0Y0D01*\n"
      : "";
    await writeFile(
      path.join(gerberDir, name),
      `%TF.GenerationSoftware,KiCad,Pcbnew,10.0.8*%\n${fileFunction}\n%FSLAX46Y46*%\n%MOMM*%\n${layerData}M02*\n`,
    );
  }
  await writeFile(path.join(gerberDir, "rc_filter-job.gbrjob"), "{}\n");
  await writeFile(
    path.join(drillDir, "rc_filter-PTH.drl"),
    "M48\n; #@! TF.FileFunction,Plated,1,2,PTH\nMETRIC\nM30\n",
  );
  await writeFile(
    path.join(drillDir, "rc_filter-NPTH.drl"),
    "M48\n; #@! TF.FileFunction,NonPlated,1,2,NPTH\nMETRIC\nM30\n",
  );
  const drillReportFile = path.join(drillDir, "drill-report.txt");
  await writeFile(
    drillReportFile,
    "Total plated holes count 0\nTotal unplated holes count 0\n",
  );
  const positionFile = path.join(root, "front-pos.csv");
  await writeFile(
    positionFile,
    'Ref,Val,Package,PosX,PosY,Rot,Side\r\n"C1","100n","C_0603_1608Metric",7.5,5,0,top\r\n"R1","1k","R_0603_1608Metric",4.5,5,0,top\r\n',
  );
  const bom = {
    items: [
      { reference: "R1", footprint_and_pin_map: { footprint: "Resistor_SMD:R_0603_1608Metric" } },
      { reference: "C1", footprint_and_pin_map: { footprint: "Capacitor_SMD:C_0603_1608Metric" } },
    ],
  };
  const kicad = { components: { R1: { value: "1k" }, C1: { value: "100n" } } };
  const validate = (overrides = {}) =>
    validateManufacturingExports({
      gerberDir,
      drillDir,
      drillReportFile,
      positionFile,
      bom,
      kicad,
      boardWidthMm: 14,
      boardHeightMm: 8,
      coordinateOrigin: { x_mm: 93, y_mm: 104 },
      hashFile: async (filename) => createHash("sha256").update(await readFile(filename)).digest("hex"),
      ...overrides,
    });
  return { root, gerberDir, drillDir, positionFile, validate };
}

test("checks Gerber layers, Excellon drills, and placement rows against the KiCad BOM", async () => {
  const fixture = await makeFixture();
  try {
    const summary = await fixture.validate();
    assert.equal(summary.status, "exports_checked_physical_release_review_required");
    assert.equal(summary.gerber_layers.length, 7);
    assert.deepEqual(summary.edge_bounds_mm, { min_x_mm: 0, min_y_mm: 0, max_x_mm: 14, max_y_mm: 8 });
    assert.equal(summary.drill_report.plated_holes, 0);
    assert.equal(summary.front_position_file.component_count, 2);
    assert.deepEqual(summary.front_position_file.component_references, ["C1", "R1"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a missing fabrication layer", async () => {
  const fixture = await makeFixture();
  try {
    await rm(path.join(fixture.gerberDir, "rc_filter-B_Cu.gbr"));
    await assert.rejects(fixture.validate(), /rc_filter-B_Cu\.gbr/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects placement references that do not match the source BOM", async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(fixture.positionFile, 'Ref,Val,Package,PosX,PosY,Rot,Side\n"R1","1k","R_0603_1608Metric",4.5,5,0,top\n');
    await assert.rejects(fixture.validate(), /exactly match the source-linked BOM/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects placement coordinates outside the origin-relative board outline", async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(fixture.positionFile, 'Ref,Val,Package,PosX,PosY,Rot,Side\n"R1","1k","R_0603_1608Metric",4.5,-1,0,top\n"C1","100n","C_0603_1608Metric",7.5,5,0,top\n');
    await assert.rejects(fixture.validate(), /outside the board origin bounds/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects blank placement coordinates and rotation fields", async () => {
  const fixture = await makeFixture();
  try {
    for (const [column, expected] of [["PosX", /PosX/], ["PosY", /PosY/], ["Rot", /Rot/]]) {
      const x = column === "PosX" ? "" : "4.5";
      const y = column === "PosY" ? "" : "5";
      const rotation = column === "Rot" ? "" : "0";
      await writeFile(
        fixture.positionFile,
        `Ref,Val,Package,PosX,PosY,Rot,Side\n"R1","1k","R_0603_1608Metric",${x},${y},${rotation},top\n"C1","100n","C_0603_1608Metric",7.5,5,0,top\n`,
      );
      await assert.rejects(fixture.validate(), expected);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an Edge.Cuts Gerber whose origin-relative bounds disagree with the board envelope", async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(
      path.join(fixture.gerberDir, "rc_filter-Edge_Cuts.gbr"),
      `%TF.GenerationSoftware,KiCad,Pcbnew,10.0.8*%\n%TF.FileFunction,Profile,NP*%\n%FSLAX46Y46*%\n%MOMM*%\nX1000000Y0D02*\nX15000000Y0D01*\nX15000000Y8000000D01*\nX1000000Y8000000D01*\nX1000000Y0D01*\nM02*\n`,
    );
    await assert.rejects(fixture.validate(), /origin-relative board dimensions/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects drill report counts outside the drilled-free reference board contract", async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(path.join(fixture.drillDir, "drill-report.txt"), "Total plated holes count 1\nTotal unplated holes count 0\n");
    await assert.rejects(fixture.validate(), /no plated holes/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
