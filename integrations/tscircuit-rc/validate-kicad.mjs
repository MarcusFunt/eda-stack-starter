import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCircuitMapping, parseKicadNetlist } from "./kicad-consistency.mjs";
import { validateManufacturingExports } from "./manufacturing-exports.mjs";
import { buildNativeKicadProject } from "./native-kicad-project.mjs";
import { prepareKicadValidationOutput } from "./kicad-validation-output.mjs";
import { buildSpiceSourceManifest } from "./source-build.mjs";
import { assertPathsDisjoint, workspaceRelativePath } from "./workspace-path.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");
const templateDir = path.resolve(
  process.env.EDASTACK_KICAD_TEMPLATE_DIR || path.join(here, "kicad"),
);
const kicadDir = path.resolve(
  process.env.EDASTACK_KICAD_PROJECT_DIR || path.join(projectRoot, "build", "tscircuit-rc", "kicad-generated"),
);
const buildDir = path.resolve(
  process.env.EDASTACK_KICAD_VALIDATION_DIR || path.join(projectRoot, "build", "tscircuit-rc", "kicad-validation"),
);
const image =
  "kicad/kicad@sha256:3f4a01786dfbe803a65f345c3342b765db9add913f5e9448f8356793714ddc34";
const containerRoot = "/workspace";
workspaceRelativePath(projectRoot, templateDir);
const relativeKicadDir = workspaceRelativePath(projectRoot, kicadDir);
const relativeBuildDir = workspaceRelativePath(projectRoot, buildDir);
assertPathsDisjoint({ template: templateDir, generated: kicadDir, validation: buildDir });
const fabricationDir = path.join(buildDir, "fabrication");
const sourceBuildDir = path.join(buildDir, "spice-source");
const relativeFabricationDir = workspaceRelativePath(projectRoot, fabricationDir);
const containerKicadDir = containerRoot + "/" + relativeKicadDir.replaceAll("\\", "/");
const containerBuildDir = containerRoot + "/" + relativeBuildDir.replaceAll("\\", "/");
const containerFabricationDir = containerRoot + "/" + relativeFabricationDir.replaceAll("\\", "/");

await prepareKicadValidationOutput(buildDir, kicadDir);

function dockerKicad(args) {
  const mountSource = projectRoot.replaceAll("\\", "/");
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--pull=missing",
      "--mount",
      "type=bind,source=" + mountSource + ",target=" + containerRoot,
      "--workdir",
      containerKicadDir,
      "--entrypoint",
      "kicad-cli",
      image,
      ...args,
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || result.stdout;
    throw new Error("KiCad command failed (" + args.join(" ") + "): " + detail);
  }
  return (result.stdout || "") + (result.stderr || "");
}

async function sha256(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

const [design, bom] = await Promise.all([
  readFile(path.join(here, "design.json"), "utf8").then(JSON.parse),
  readFile(path.join(projectRoot, "examples", "rc_operating_cases", "bom.json"), "utf8").then(JSON.parse),
]);
const sourceManifest = await buildSpiceSourceManifest({
  sourceScript: path.join(here, "build-spice.mjs"),
  outputDir: sourceBuildDir,
  design,
});
await buildNativeKicadProject({ workspaceRoot: projectRoot, templateDir, outputDir: kicadDir, design, sourceManifest });
const kicadVersion = dockerKicad(["version"]);
assert.match(kicadVersion, /10\.0\.8/, "Validator image must provide KiCad 10.0.8");
dockerKicad([
  "sch",
  "erc",
  "--format",
  "json",
  "--output",
  containerBuildDir + "/erc.json",
  containerKicadDir + "/rc_filter.kicad_sch",
]);
dockerKicad([
  "pcb",
  "drc",
  "--schematic-parity",
  "--format",
  "json",
  "--output",
  containerBuildDir + "/drc.json",
  containerKicadDir + "/rc_filter.kicad_pcb",
]);
dockerKicad([
  "sch",
  "export",
  "netlist",
  "--output",
  containerBuildDir + "/netlist.net",
  containerKicadDir + "/rc_filter.kicad_sch",
]);
dockerKicad([
  "pcb",
  "export",
  "stats",
  "--format",
  "json",
  "--output",
  containerBuildDir + "/board-stats.json",
  containerKicadDir + "/rc_filter.kicad_pcb",
]);
dockerKicad([
  "pcb",
  "render",
  "--output",
  containerBuildDir + "/board-preview.png",
  "--width",
  "1200",
  "--height",
  "800",
  "--quality",
  "high",
  "--rotate",
  "-45,0,45",
  containerKicadDir + "/rc_filter.kicad_pcb",
]);

const boardPath = containerKicadDir + "/rc_filter.kicad_pcb";
dockerKicad([
  "pcb",
  "export",
  "gerbers",
  "--output",
  containerFabricationDir + "/gerbers",
  "--layers",
  "F.Cu,B.Cu,F.Mask,B.Mask,F.Paste,F.Silkscreen,Edge.Cuts",
  "--precision",
  "6",
  "--use-drill-file-origin",
  "--no-protel-ext",
  boardPath,
]);
dockerKicad([
  "pcb",
  "export",
  "drill",
  "--output",
  containerFabricationDir + "/drill",
  "--drill-origin",
  "plot",
  "--excellon-units",
  "mm",
  "--excellon-separate-th",
  "--generate-map",
  "--map-format",
  "svg",
  "--generate-report",
  "--report-path",
  containerFabricationDir + "/drill/drill-report.txt",
  boardPath,
]);
dockerKicad([
  "pcb",
  "export",
  "pos",
  "--output",
  containerFabricationDir + "/front-pos.csv",
  "--format",
  "csv",
  "--units",
  "mm",
  "--side",
  "front",
  "--smd-only",
  "--use-drill-file-origin",
  "--exclude-dnp",
  boardPath,
]);

const [erc, drc, netlistText, boardStatsText] = await Promise.all([
  readFile(path.join(buildDir, "erc.json"), "utf8").then(JSON.parse),
  readFile(path.join(buildDir, "drc.json"), "utf8").then(JSON.parse),
  readFile(path.join(buildDir, "netlist.net"), "utf8"),
  readFile(path.join(buildDir, "board-stats.json"), "utf8"),
]);
const ercViolations = erc.sheets.flatMap((sheet) => sheet.violations);
const kicad = parseKicadNetlist(netlistText);
const sourceNodes = assertCircuitMapping({ design, sourceManifest, bom, kicad });
const boardStats = JSON.parse(boardStatsText);
const boardWidthMm = Number(boardStats.board.width.replace(/\s*mm$/, ""));
const boardHeightMm = Number(boardStats.board.height.replace(/\s*mm$/, ""));
assert.equal(boardWidthMm, 14, "Reference RC board width must match its documented 14 mm envelope");
assert.equal(boardHeightMm, 8, "Reference RC board height must match its documented 8 mm envelope");
const boardText = await readFile(path.join(kicadDir, "rc_filter.kicad_pcb"), "utf8");
const originMatch = boardText.match(/\(aux_axis_origin\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)/);
assert.ok(originMatch, "KiCad board must define a fabrication drill/place origin");
const coordinateOrigin = { x_mm: Number(originMatch[1]), y_mm: Number(originMatch[2]) };
assert.deepEqual(coordinateOrigin, { x_mm: 93, y_mm: 104 }, "Fabrication origin must remain at the board's lower-left corner");
assert.equal(ercViolations.length, 0, "KiCad ERC must pass without violations");
assert.equal(drc.violations.length, 0, "KiCad DRC must pass without violations");
assert.equal(drc.unconnected_items.length, 0, "Board must have no unconnected items");
assert.equal(drc.schematic_parity.length, 0, "Schematic/PCB parity must pass");

const manufacturing = await validateManufacturingExports({
  gerberDir: path.join(fabricationDir, "gerbers"),
  drillDir: path.join(fabricationDir, "drill"),
  drillReportFile: path.join(fabricationDir, "drill", "drill-report.txt"),
  positionFile: path.join(fabricationDir, "front-pos.csv"),
  bom,
  kicad,
  boardWidthMm,
  boardHeightMm,
  coordinateOrigin,
  hashFile: sha256,
});

const artifactNames = [
  "rc_filter.kicad_pro",
  "rc_filter.kicad_sch",
  "rc_filter.kicad_pcb",
  "sym-lib-table",
  "fp-lib-table",
];
const artifactHashes = Object.fromEntries(
  await Promise.all(
    artifactNames.map(async (name) => [
      name,
      await sha256(path.join(kicadDir, name)),
    ]),
  ),
);
const summary = {
  schema_version: 1,
  validated_at_utc: new Date().toISOString(),
  kicad_version: "10.0.8",
  image,
  project: path.relative(projectRoot, path.join(kicadDir, "rc_filter.kicad_pro")).replaceAll("\\", "/"),
  native_template: path.relative(projectRoot, templateDir).replaceAll("\\", "/"),
  native_template_scope: "fixed RC topology; tscircuit values propagated to reviewed KiCad template",
  source_design: {
    resistance: design.parameters.resistance,
    capacitance: design.parameters.capacitance,
    spice_nodes: {
      input: sourceNodes.inputNode,
      output: sourceNodes.outputNode,
      ground: sourceNodes.groundNode,
    },
  },
  kicad_nets: kicad.nets,
  results: {
    erc_violations: ercViolations.length,
    drc_violations: drc.violations.length,
    unconnected_items: drc.unconnected_items.length,
    schematic_parity_issues: drc.schematic_parity.length,
  },
  manufacturing_outputs: manufacturing,
  board_stats: boardStats,
  artifacts_sha256: artifactHashes,
  files: {
    erc: path.relative(projectRoot, path.join(buildDir, "erc.json")).replaceAll("\\", "/"),
    drc: path.relative(projectRoot, path.join(buildDir, "drc.json")).replaceAll("\\", "/"),
    netlist: path.relative(projectRoot, path.join(buildDir, "netlist.net")).replaceAll("\\", "/"),
    board_stats: path.relative(projectRoot, path.join(buildDir, "board-stats.json")).replaceAll("\\", "/"),
    board_preview: path.relative(projectRoot, path.join(buildDir, "board-preview.png")).replaceAll("\\", "/"),
    manufacturing_manifest: path.relative(projectRoot, path.join(fabricationDir, "manifest.json")).replaceAll("\\", "/"),
  },
};
await writeFile(
  path.join(fabricationDir, "manifest.json"),
  JSON.stringify(
    {
      schema_version: 1,
      validated_at_utc: summary.validated_at_utc,
      status: "exports_checked; physical_release_review_required",
      kicad_version: summary.kicad_version,
      board_sha256: artifactHashes["rc_filter.kicad_pcb"],
      bom_sha256: await sha256(path.join(projectRoot, "examples", "rc_operating_cases", "bom.json")),
      design_sha256: await sha256(path.join(here, "design.json")),
      requirement_spec_sha256: await sha256(path.join(projectRoot, "examples", "rc_filter", "spec.json")),
      source_spice_sha256: await sha256(path.join(sourceBuildDir, "generated.cir")),
      erc_violations: ercViolations.length,
      drc_violations: drc.violations.length,
      unconnected_items: drc.unconnected_items.length,
      schematic_parity_issues: drc.schematic_parity.length,
      manufacturing_outputs: manufacturing,
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  path.join(buildDir, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
process.stdout.write(
  "KiCad " +
    summary.kicad_version +
    ": ERC 0, DRC 0, unconnected 0, parity 0. Summary: " +
    path.join(buildDir, "summary.json") +
    "\n",
);
