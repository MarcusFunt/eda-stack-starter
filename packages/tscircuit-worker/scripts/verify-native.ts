import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPinNetMembership,
  exportCircuitJsonToKicad,
  parseKicadNetlistPinNetGroups,
  sourcePinNetGroups,
} from "../src/export-kicad.js";

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
    { cwd: repositoryRoot, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      "KiCad CLI failed (" + args.join(" ") + "): " + (result.error?.message ?? result.stderr ?? result.stdout),
    );
  }
  return (result.stdout ?? "") + (result.stderr ?? "");
}

const version = kicadCli(["version"]);
assert.match(version, /10\.0\.8/, "native export verification requires KiCad 10.0.8");

const rcBuildDir = path.join(runRoot, "rc-source");
const rcBuilder = path.join(repositoryRoot, "integrations", "tscircuit-rc", "build-spice.mjs");
const rcBuild = spawnSync(process.execPath, [rcBuilder, "1k", "100n", rcBuildDir], {
  cwd: path.dirname(rcBuilder),
  encoding: "utf8",
  timeout: 120_000,
});
if (rcBuild.error || rcBuild.status !== 0) {
  throw new Error("Could not build Circuit JSON from the existing RC source: " + (rcBuild.error?.message ?? rcBuild.stderr));
}

const fixtureCircuits = [
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

const results: Array<Record<string, unknown>> = [];
let hasErcFindings = false;
let hasPcbDrcFindings = false;
for (const fixture of fixtureCircuits) {
  const outputDir = path.join(runRoot, fixture.name);
  const output = await exportCircuitJsonToKicad({ circuitJson: fixture.circuitJson, outputDir, projectName: fixture.name });
  const relativeOutput = path.relative(repositoryRoot, outputDir).replaceAll("\\", "/");
  const containerOutput = containerRoot + "/" + relativeOutput;
  const nativeNetlistPath = containerOutput + "/native-schematic.net";
  const ercPath = containerOutput + "/erc.json";
  const drcPath = containerOutput + "/pcb-drc.json";
  const svgDirectory = containerOutput + "/rendered-svg";
  const schematicPath = containerOutput + "/" + fixture.name + ".kicad_sch";
  const pcbPath = containerOutput + "/" + fixture.name + ".kicad_pcb";

  kicadCli(["sch", "export", "svg", "--output", svgDirectory, schematicPath], containerOutput);
  kicadCli(["sch", "export", "netlist", "--output", nativeNetlistPath, schematicPath], containerOutput);
  kicadCli(["sch", "erc", "--format", "json", "--output", ercPath, schematicPath], containerOutput);
  kicadCli(["pcb", "drc", "--format", "json", "--output", drcPath, pcbPath], containerOutput);

  const nativeNetlist = parseKicadNetlistPinNetGroups(await readFile(path.join(outputDir, "native-schematic.net"), "utf8"));
  const expectedNetlist = sourcePinNetGroups(fixture.circuitJson);
  assertPinNetMembership(expectedNetlist, nativeNetlist);

  const erc = JSON.parse(await readFile(path.join(outputDir, "erc.json"), "utf8"));
  const ercViolations = (erc.sheets ?? []).flatMap((sheet: { violations?: unknown[] }) => sheet.violations ?? []);
  hasErcFindings ||= ercViolations.length > 0;

  const drc = JSON.parse(await readFile(path.join(outputDir, "pcb-drc.json"), "utf8"));
  hasPcbDrcFindings ||= (drc.violations?.length ?? 0) > 0;
  const schematicSvgs = await readdir(path.join(outputDir, "rendered-svg"));
  assert.ok(schematicSvgs.length > 0, fixture.name + " schematic must render to SVG in native KiCad");
  const svgText = await Promise.all(
    schematicSvgs.filter((filename) => filename.toLowerCase().endsWith(".svg")).map(async (filename) =>
      readFile(path.join(outputDir, "rendered-svg", filename), "utf8"),
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
    erc_findings: ercViolations,
    erc_finding_count: ercViolations.length,
    pcb_drc_findings: drc.violations ?? [],
    pcb_drc_violations: drc.violations?.length ?? null,
    rendered_schematic_svgs: schematicSvgs.filter((filename) => filename.toLowerCase().endsWith(".svg")),
    output: relativeOutput,
    files: output.files,
  });
}

const summary = {
  schema_version: 1,
  status: hasErcFindings || hasPcbDrcFindings ? "connectivity_pass_native_findings_present" : "all_native_checks_passed",
  native_pin_net_membership: "passed",
  erc_status: hasErcFindings ? "review_required" : "passed",
  pcb_drc_status: hasPcbDrcFindings ? "review_required" : "passed",
  kicad_version: version.trim(),
  converter_version: "0.0.270",
  native_netlist_connectivity: "exact physical-pin membership",
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
    pin_net_membership: "exact",
    erc_findings: findingCounts,
    pcb_drc_violations: result.pcb_drc_violations,
    rendered_schematic_svgs: result.rendered_schematic_svgs,
    output: result.output,
  };
});
process.stdout.write(
  JSON.stringify(
    {
      summary: path.join(runRoot, "verification-summary.json"),
      status: summary.status,
      kicad_version: summary.kicad_version,
      converter_version: summary.converter_version,
      fixtures: consoleResults,
    },
    null,
    2,
  ) + "\n",
);
