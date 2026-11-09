import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPinNetMembership,
  exportCircuitJsonToKicad,
  parseKicadNetlistPinNetGroups,
  sourcePinNetGroups,
} from "../src/export-kicad.js";
import { createPcbDrcArgs, readPcbDrcEvidence } from "../src/native-drc.js";
import { buildProject } from "../src/build.js";

type NativeFixture = {
  name: string;
  circuitJson: unknown[];
  kicadDirectory?: string;
  kicadProjectName?: string;
  buildDirectory?: string;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const image = "kicad/kicad@sha256:3f4a01786dfbe803a65f345c3342b765db9add913f5e9448f8356793714ddc34";
const containerRoot = "/workspace";
const buildRoot = path.join(repositoryRoot, "build");
await mkdir(buildRoot, { recursive: true });
const runRoot = await mkdtemp(path.join(buildRoot, "tscircuit-worker-native-"));

function dockerUserOptions(): string[] {
  if (process.platform === "win32") return [];
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error("KiCad container validation requires the host UID and GID on POSIX");
  }
  return ["--user", uid + ":" + gid, "--env", "HOME=/tmp"];
}

function kicadCli(args: string[], workingDirectory = containerRoot): string {
  const mountSource = repositoryRoot.replaceAll("\\", "/");
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      ...dockerUserOptions(),
      "--pull=missing",
      "--mount",
      "type=bind,source=" + mountSource + ",target=" + containerRoot,
      "--workdir",
      workingDirectory,
      "--entrypoint",
      "kicad-cli",
      image,
      ...args,
    ],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      "KiCad CLI failed (" + args.join(" ") + "): " + (result.error?.message ?? result.stderr ?? result.stdout),
    );
  }
  return (result.stdout ?? "") + (result.stderr ?? "");
}

async function implementationHash(): Promise<string> {
  const sourceRoots = [path.join(repositoryRoot, "packages", "tscircuit-worker", "src"), path.join(repositoryRoot, "packages", "tscircuit-compiler", "src")];
  const sources: Array<{ path: string; sha256: string }> = [];
  async function walk(root: string, directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(root, fullPath);
      else if (entry.isFile() && /\.(?:ts|tsx|js|mjs)$/.test(entry.name)) {
        const relative = path.relative(root, fullPath).replaceAll("\\", "/");
        sources.push({ path: path.relative(repositoryRoot, fullPath).replaceAll("\\", "/"), sha256: createHash("sha256").update(await readFile(fullPath)).digest("hex") + ":" + relative });
      }
    }
  }
  for (const root of sourceRoots) await walk(root, root);
  const digest = createHash("sha256");
  for (const source of sources.sort((left, right) => left.path.localeCompare(right.path))) digest.update(source.path + "\0" + source.sha256 + "\n");
  return digest.digest("hex");
}

async function buildProjectFixture(name: string, sourceRoot?: string): Promise<NativeFixture> {
  const root = sourceRoot ?? path.join(repositoryRoot, "benchmarks", "fixtures", name);
  const buildDirectory = path.join(runRoot, "project-builds", name);
  const build = await buildProject({ projectRoot: root, outputDir: buildDirectory });
  return {
    name,
    circuitJson: JSON.parse(await readFile(build.circuitJsonPath, "utf8")) as unknown[],
    kicadDirectory: build.kicadOutputDir,
    kicadProjectName: build.projectName,
    buildDirectory,
  };
}

const version = kicadCli(["version"]);
assert.match(version, /10\.0\.8/, "native export verification requires KiCad 10.0.8");
const workerImplementationHashBefore = await implementationHash();

const rcBuildDir = path.join(runRoot, "rc-source");
const rcBuilder = path.join(repositoryRoot, "integrations", "tscircuit-rc", "build-spice.mjs");
const rcBuild = spawnSync(process.execPath, [rcBuilder, "1k", "100n", rcBuildDir], {
  cwd: path.dirname(rcBuilder),
  encoding: "utf8",
  timeout: 120_000,
  windowsHide: true,
});
if (rcBuild.error || rcBuild.status !== 0) {
  throw new Error("Could not build Circuit JSON from the existing RC source: " + (rcBuild.error?.message ?? rcBuild.stderr));
}

const fixtureCircuits: NativeFixture[] = [
  {
    name: "rc",
    circuitJson: JSON.parse(await readFile(path.join(rcBuildDir, "circuit.json"), "utf8")) as unknown[],
  },
  ...await Promise.all(
    ["two-resistor-labels", "power-rail"].map(async (name) => ({
      name,
      circuitJson: JSON.parse(await readFile(path.join(packageRoot, "fixtures", name + ".circuit.json"), "utf8")) as unknown[],
    })),
  ),
];

for (const name of ["voltage-divider", "led-transistor", "ldo-sensor-interface"]) {
  fixtureCircuits.push(await buildProjectFixture(name));
}

const ledFixture = fixtureCircuits.find((fixture) => fixture.name === "led-transistor")!;
const ledBuildManifest = JSON.parse(await readFile(path.join(ledFixture.buildDirectory!, "build-manifest.json"), "utf8"));
const mutationSourceRoot = path.join(runRoot, "source-mutation", "led-transistor-expanded");
await mkdir(path.dirname(mutationSourceRoot), { recursive: true });
await cp(path.join(repositoryRoot, "benchmarks", "fixtures", "led-transistor"), mutationSourceRoot, { recursive: true });
const mutationEntry = path.join(mutationSourceRoot, "src", "board.tsx");
const originalBoardSource = await readFile(mutationEntry, "utf8");
const insertionPoint = "    <LowSideLed />";
assert.equal(originalBoardSource.split(insertionPoint).length, 2, "LED fixture mutation anchor must be unique");
const expandedSource = originalBoardSource.replace(
  insertionPoint,
  [
    "    <net name=\"AUX_OUT\" />",
    "    <connector name=\"J2\" pinCount={2} footprint=\"pinrow2\" pcbX={10} pcbY={0} />",
    "    <resistor name=\"R3\" resistance=\"10k\" footprint=\"0603\" pcbX={5} pcbY={6} />",
    "    <trace from=\".J2 > .pin1\" to=\".R3 > .pin1\" />",
    "    <trace from=\".J2 > .pin2\" to=\"net.GND\" />",
    "    <trace from=\".R3 > .pin2\" to=\"net.AUX_OUT\" />",
    insertionPoint,
  ].join("\n"),
);
await writeFile(mutationEntry, expandedSource);
// The source mutation adds two real physical components. Keep its experimental
// parts lock synchronized, without asserting that the new parts are sourced.
const mutationLockPath = path.join(mutationSourceRoot, "parts.lock.json");
const mutationPartsLock = JSON.parse(await readFile(mutationLockPath, "utf8"));
mutationPartsLock.parts.push(
  { reference: "J2", manufacturer_part_number: null, footprint: "pinrow2", pin_map_status: "unverified" },
  { reference: "R3", manufacturer_part_number: null, footprint: "0603", pin_map_status: "unverified" },
);
await writeFile(mutationLockPath, JSON.stringify(mutationPartsLock, null, 2) + "\n");
const workerImplementationHashBeforeMutation = await implementationHash();
const expandedFixture = await buildProjectFixture("led-transistor-expanded", mutationSourceRoot);
const expandedBuildManifest = JSON.parse(await readFile(path.join(expandedFixture.buildDirectory!, "build-manifest.json"), "utf8"));
const workerImplementationHashAfterMutation = await implementationHash();
assert.equal(workerImplementationHashBeforeMutation, workerImplementationHashAfterMutation, "source-only mutation must not change worker implementation");
assert.equal(
  expandedBuildManifest.source_graph_counts.components,
  ledBuildManifest.source_graph_counts.components + 2,
  "adding an independently authored resistor and connector must increase component count by two",
);
assert.equal(
  expandedBuildManifest.source_graph_counts.nets,
  ledBuildManifest.source_graph_counts.nets + 2,
  "the connector/resistor mutation must add two physical pin-net groups",
);
fixtureCircuits.push(expandedFixture);

async function expectProjectBuildFailure(
  name: string,
  entrySource: string,
  expectedCode: string,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const sourceRoot = path.join(runRoot, "negative-projects", name);
  await cp(path.join(repositoryRoot, "benchmarks", "fixtures", "voltage-divider"), sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "src", "board.tsx"), entrySource);
  const outputDir = path.join(runRoot, "negative-builds", name);
  let failure: unknown;
  try {
    await buildProject({ projectRoot: sourceRoot, outputDir, timeoutMs });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error, name + " project must fail instead of producing artifacts");
  assert.ok(failure.message.startsWith(expectedCode + ":"), name + " must return the explicit " + expectedCode + " diagnostic; received " + failure.message);
  await assert.rejects(lstat(outputDir), { code: "ENOENT" }, name + " must not leave a stale or partial success output");
  return { fixture: name, expected_failure_code: expectedCode, actual_failure: failure.message, output_created: false };
}

const negativeBuilds = [
  await expectProjectBuildFailure("malformed-tsx", "export default () => (<board>\n", "MALFORMED_TSX"),
  await expectProjectBuildFailure(
    "sandbox-timeout",
    "export default function HangingBoard() { while (true) {} return <board />; }\n",
    "BUILD_TIMEOUT",
    15_000,
  ),
];

const sensorFixture = fixtureCircuits.find((fixture) => fixture.name === "ldo-sensor-interface")!;
const sensorSheets = sensorFixture.circuitJson.filter((item: any) => item.type === "schematic_sheet").map((item: any) => item.name).sort();
assert.deepEqual(sensorSheets, ["Power", "Sensor"], "sensor fixture must compile two separately named schematic sheets");

const results: Array<Record<string, unknown>> = [];
let hasErcFindings = false;
let hasPcbDrcFindings = false;
for (const fixture of fixtureCircuits) {
  let kicadDirectory = fixture.kicadDirectory;
  let exportedFiles: string[];
  if (kicadDirectory) {
    exportedFiles = await readdir(kicadDirectory);
  } else {
    const exported = await exportCircuitJsonToKicad({
      circuitJson: fixture.circuitJson,
      outputDir: path.join(runRoot, "kicad-exports", fixture.name),
      projectName: fixture.name,
    });
    kicadDirectory = exported.outputDir;
    exportedFiles = exported.files;
  }
  const nativeOutputDirectory = path.join(runRoot, "native-results", fixture.name);
  await mkdir(nativeOutputDirectory, { recursive: true });
  const relativeNative = path.relative(repositoryRoot, nativeOutputDirectory).replaceAll("\\", "/");
  const relativeKicad = path.relative(repositoryRoot, kicadDirectory).replaceAll("\\", "/");
  const containerNative = containerRoot + "/" + relativeNative;
  const containerKicad = containerRoot + "/" + relativeKicad;
  const kicadProjectName = fixture.kicadProjectName ?? fixture.name;
  const nativeNetlistPath = containerNative + "/native-schematic.net";
  const ercPath = containerNative + "/erc.json";
  const drcPath = containerNative + "/pcb-drc.json";
  const svgDirectory = containerNative + "/rendered-svg";
  const schematicPath = containerKicad + "/" + kicadProjectName + ".kicad_sch";
  const pcbPath = containerKicad + "/" + kicadProjectName + ".kicad_pcb";

  kicadCli(["sch", "export", "svg", "--output", svgDirectory, schematicPath], containerNative);
  kicadCli(["sch", "export", "netlist", "--output", nativeNetlistPath, schematicPath], containerNative);
  kicadCli(["sch", "erc", "--format", "json", "--output", ercPath, schematicPath], containerNative);
  kicadCli(createPcbDrcArgs(drcPath, pcbPath), containerNative);

  const nativeNetlist = parseKicadNetlistPinNetGroups(await readFile(path.join(nativeOutputDirectory, "native-schematic.net"), "utf8"));
  const expectedNetlist = sourcePinNetGroups(fixture.circuitJson);
  assertPinNetMembership(expectedNetlist, nativeNetlist);

  const erc = JSON.parse(await readFile(path.join(nativeOutputDirectory, "erc.json"), "utf8"));
  const ercViolations = (erc.sheets ?? []).flatMap((sheet: { violations?: unknown[] }) => sheet.violations ?? []);
  hasErcFindings ||= ercViolations.length > 0;

  const drc = JSON.parse(await readFile(path.join(nativeOutputDirectory, "pcb-drc.json"), "utf8"));
  const drcEvidence = readPcbDrcEvidence(drc, fixture.name + ": KiCad PCB DRC report");
  hasPcbDrcFindings ||= drcEvidence.findings.length > 0;
  const schematicSvgs = await readdir(path.join(nativeOutputDirectory, "rendered-svg"));
  assert.ok(schematicSvgs.length > 0, fixture.name + " schematic must render to SVG in native KiCad");
  const svgText = await Promise.all(
    schematicSvgs.filter((filename) => filename.toLowerCase().endsWith(".svg")).map(async (filename) =>
      readFile(path.join(nativeOutputDirectory, "rendered-svg", filename), "utf8"),
    ),
  );
  assert.ok(svgText.length > 0, fixture.name + " native KiCad SVG export must produce SVG files");
  const renderedText = svgText.join("\n");
  for (const component of fixture.circuitJson.filter((item: any) => item.type === "source_component") as Array<{ name: string }>) {
    assert.ok(renderedText.includes(component.name), fixture.name + " SVG must render component " + component.name);
  }
  results.push({
    fixture: fixture.name,
    source_components: fixture.circuitJson.filter((item: any) => item.type === "source_component").length,
    source_pin_net_groups: expectedNetlist,
    native_pin_net_groups: nativeNetlist,
    pin_net_membership: "exact",
    erc_findings: ercViolations,
    erc_finding_count: ercViolations.length,
    erc_ignored_checks: erc.ignored_checks ?? null,
    pcb_drc_ignored_checks: drc.ignored_checks ?? null,
    pcb_drc_findings: drcEvidence.findings,
    pcb_drc_violations: drcEvidence.findings.length,
    pcb_unconnected_items: drcEvidence.unconnectedItems,
    pcb_schematic_parity_issues: drcEvidence.schematicParityIssues,
    rendered_schematic_svgs: schematicSvgs.filter((filename) => filename.toLowerCase().endsWith(".svg")),
    native_output: relativeNative,
    project_build: fixture.buildDirectory ? path.relative(repositoryRoot, fixture.buildDirectory).replaceAll("\\", "/") : null,
    kicad_export_files: exportedFiles.sort(),
  });
}

const workerImplementationHashAfter = await implementationHash();
assert.equal(workerImplementationHashBefore, workerImplementationHashAfter, "all authored fixture builds must use the same worker implementation");
const summary = {
  schema_version: 1,
  status: hasErcFindings || hasPcbDrcFindings ? "connectivity_pass_native_findings_present" : "all_native_checks_passed",
  native_pin_net_membership: "passed",
  erc_status: hasErcFindings ? "review_required" : "passed",
  pcb_drc_status: hasPcbDrcFindings ? "review_required" : "passed",
  kicad_version: version.trim(),
  converter_version: "0.0.270",
  tscircuit_version: "0.0.3114",
  native_netlist_connectivity: "exact physical-pin membership",
  project_families: ["voltage-divider", "led-transistor", "ldo-sensor-interface"],
  source_mutation_proof: {
    changed_files: ["src/board.tsx"],
    worker_implementation_sha256: workerImplementationHashAfter,
    worker_unchanged: true,
    base_components: ledBuildManifest.source_graph_counts.components,
    expanded_components: expandedBuildManifest.source_graph_counts.components,
    base_nets: ledBuildManifest.source_graph_counts.nets,
    expanded_nets: expandedBuildManifest.source_graph_counts.nets,
  },
  negative_builds: negativeBuilds,
  fixtures: results,
};
await writeFile(path.join(runRoot, "verification-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
const consoleResults = results.map((result) => {
  const findings = result.erc_findings as Array<{ type?: string }>;
  const findingCounts = Object.fromEntries(
    [...new Set(findings.map((finding) => finding.type ?? "unknown"))].sort().map((type) => [
      type,
      findings.filter((finding) => finding.type === type).length,
    ]),
  );
  return {
    fixture: result.fixture,
    source_components: result.source_components,
    pin_net_membership: result.pin_net_membership,
    erc_findings: findingCounts,
    pcb_drc_violations: result.pcb_drc_violations,
    rendered_schematic_svgs: result.rendered_schematic_svgs,
    native_output: result.native_output,
  };
});
process.stdout.write(
  JSON.stringify(
    {
      summary: path.join(runRoot, "verification-summary.json"),
      status: summary.status,
      kicad_version: summary.kicad_version,
      converter_version: summary.converter_version,
      source_mutation_proof: summary.source_mutation_proof,
      negative_builds: summary.negative_builds,
      fixtures: consoleResults,
    },
    null,
    2,
  ) + "\n",
);
