import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const GERBERS = [
  ["rc_filter-F_Cu.gbr", "%TF.FileFunction,Copper,L1,Top*%"],
  ["rc_filter-B_Cu.gbr", "%TF.FileFunction,Copper,L2,Bot*%"],
  ["rc_filter-F_Mask.gbr", "%TF.FileFunction,Soldermask,Top*%"],
  ["rc_filter-B_Mask.gbr", "%TF.FileFunction,Soldermask,Bot*%"],
  ["rc_filter-F_Paste.gbr", "%TF.FileFunction,Paste,Top*%"],
  ["rc_filter-F_Silkscreen.gbr", "%TF.FileFunction,Legend,Top*%"],
  ["rc_filter-Edge_Cuts.gbr", "%TF.FileFunction,Profile,NP*%"],
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("Front-side position CSV has an unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  return rows;
}

function hashRecord(file, fileStat, hash) {
  return { file, size_bytes: fileStat.size, sha256: hash };
}

export async function validateManufacturingExports({
  gerberDir,
  drillDir,
  drillReportFile,
  positionFile,
  bom,
  kicad,
  boardWidthMm,
  boardHeightMm,
  coordinateOrigin,
  hashFile,
}) {
  const gerbers = [];
  for (const [file, fileFunction] of GERBERS) {
    const fullPath = path.join(gerberDir, file);
    const [content, fileStat, sha256] = await Promise.all([
      readFile(fullPath, "utf8"),
      stat(fullPath),
      hashFile(fullPath),
    ]);
    assert.ok(fileStat.isFile() && fileStat.size > 0, file + " must be a non-empty file");
    assert.ok(content.startsWith("%TF.GenerationSoftware,KiCad,Pcbnew,10.0.8*%\n"), file + " has an unexpected KiCad header");
    assert.ok(content.includes(fileFunction), file + " declares the wrong Gerber layer function");
    assert.ok(content.includes("%MOMM*%") && content.trimEnd().endsWith("M02*"), file + " is not a complete metric Gerber file");
    gerbers.push(hashRecord(file, fileStat, sha256));
  }

  const edgeGerber = await readFile(path.join(gerberDir, "rc_filter-Edge_Cuts.gbr"), "utf8");
  const edgeCoordinates = [...edgeGerber.matchAll(/^X(-?\d+)Y(-?\d+)D0[12]\*$/gm)].map((match) => ({
    x: Number(match[1]) / 1_000_000,
    y: Number(match[2]) / 1_000_000,
  }));
  assert.ok(edgeCoordinates.length >= 4, "Edge.Cuts Gerber must contain a closed board outline");
  const edgeBounds = {
    min_x_mm: Math.min(...edgeCoordinates.map((point) => point.x)),
    min_y_mm: Math.min(...edgeCoordinates.map((point) => point.y)),
    max_x_mm: Math.max(...edgeCoordinates.map((point) => point.x)),
    max_y_mm: Math.max(...edgeCoordinates.map((point) => point.y)),
  };
  assert.deepEqual(
    edgeBounds,
    { min_x_mm: 0, min_y_mm: 0, max_x_mm: boardWidthMm, max_y_mm: boardHeightMm },
    "Edge.Cuts Gerber must align with the origin-relative board dimensions",
  );

  const gerberNames = await readdir(gerberDir);
  assert.ok(gerberNames.includes("rc_filter-job.gbrjob"), "Gerber X2 job file is missing");
  const jobPath = path.join(gerberDir, "rc_filter-job.gbrjob");
  const [jobStat, jobSha256] = await Promise.all([stat(jobPath), hashFile(jobPath)]);
  assert.ok(jobStat.isFile() && jobStat.size > 0, "Gerber X2 job file must be non-empty");

  const drillFiles = [];
  for (const [file, expectedFunction] of [
    ["rc_filter-PTH.drl", "FileFunction,Plated,1,2,PTH"],
    ["rc_filter-NPTH.drl", "FileFunction,NonPlated,1,2,NPTH"],
  ]) {
    const fullPath = path.join(drillDir, file);
    const [content, fileStat, sha256] = await Promise.all([
      readFile(fullPath, "utf8"),
      stat(fullPath),
      hashFile(fullPath),
    ]);
    assert.ok(fileStat.isFile() && fileStat.size > 0, file + " must be a non-empty Excellon file");
    assert.ok(content.startsWith("M48\n") && content.includes(expectedFunction), file + " has the wrong drill file function");
    assert.ok(content.includes("METRIC") && content.trimEnd().endsWith("M30"), file + " is not a complete metric Excellon file");
    drillFiles.push(hashRecord(file, fileStat, sha256));
  }

  const drillReport = await readFile(drillReportFile, "utf8");
  assert.match(drillReport, /Total plated holes count\s+0\b/, "The reference board must have no plated holes");
  assert.match(drillReport, /Total unplated holes count\s+0\b/, "The reference board must have no unplated holes");
  const drillReportStat = await stat(drillReportFile);
  const drillReportSha256 = await hashFile(drillReportFile);

  const rows = parseCsv(await readFile(positionFile, "utf8"));
  assert.deepEqual(
    rows[0],
    ["Ref", "Val", "Package", "PosX", "PosY", "Rot", "Side"],
    "Front-side placement CSV header changed",
  );
  const positions = rows.slice(1).map((values) => {
    assert.equal(values.length, rows[0].length, "Front-side position row has the wrong number of columns");
    return Object.fromEntries(rows[0].map((key, index) => [key, values[index]]));
  });
  const expectedParts = [...bom.items].sort((left, right) => left.reference.localeCompare(right.reference));
  assert.deepEqual(
    positions.map((item) => item.Ref).sort(),
    expectedParts.map((item) => item.reference),
    "Front-side placement references must exactly match the source-linked BOM parts",
  );
  for (const item of expectedParts) {
    const row = positions.find((position) => position.Ref === item.reference);
    assert.equal(row.Val, kicad.components[item.reference].value, item.reference + " placement value differs from KiCad");
    assert.equal(
      row.Package,
      item.footprint_and_pin_map.footprint.split(":").at(-1),
      item.reference + " placement footprint differs from the source-linked BOM",
    );
    assert.equal(row.Side, "top", item.reference + " must be on the front side");
    for (const coordinate of ["PosX", "PosY", "Rot"]) {
      const value = row[coordinate].trim();
      assert.ok(value.length > 0 && Number.isFinite(Number(value)), item.reference + " has non-numeric " + coordinate);
    }
    assert.ok(Number(row.PosX) >= 0 && Number(row.PosX) <= boardWidthMm, item.reference + " X placement is outside the board origin bounds");
    assert.ok(Number(row.PosY) >= 0 && Number(row.PosY) <= boardHeightMm, item.reference + " Y placement is outside the board origin bounds");
  }
  const positionStat = await stat(positionFile);
  const positionSha256 = await hashFile(positionFile);

  return {
    status: "exports_checked_physical_release_review_required",
    coordinate_origin: { ...coordinateOrigin, placement_bounds_mm: [boardWidthMm, boardHeightMm] },
    edge_bounds_mm: edgeBounds,
    gerber_layers: gerbers,
    gerber_job: hashRecord("rc_filter-job.gbrjob", jobStat, jobSha256),
    drill_files: drillFiles,
    drill_report: {
      ...hashRecord("drill-report.txt", drillReportStat, drillReportSha256),
      plated_holes: 0,
      unplated_holes: 0,
    },
    front_position_file: {
      ...hashRecord("front-pos.csv", positionStat, positionSha256),
      component_references: positions.map((item) => item.Ref).sort(),
      component_count: positions.length,
    },
  };
}
