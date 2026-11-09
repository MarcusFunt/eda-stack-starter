import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourcePinNetGroups, parseKicadNetlistPinNetGroups, assertPinNetMembership } from "../src/connectivity.js";
import { checkGeneralNativeRelease } from "../src/release-gate.js";
import { createPcbDrcArgs, readPcbDrcEvidence } from "../src/native-drc.js";

const { values } = parseArgs({
  options: {
    build: { type: "string" },
    strict: { type: "boolean", default: false },
  }, strict: true,
});
if (!values.build) throw new Error("Usage: npm run verify:project -- --build <existing-build-directory> [--strict]");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const build = path.resolve(values.build);
const relative = path.relative(repo, build).replaceAll("\\", "/");
if (relative === "" || relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
  throw new Error("Project build must be a directory inside the repository");
}
const project = JSON.parse(await readFile(path.join(build, "build-manifest.json"), "utf8"));
const name = project.project_name;
assert.match(name, /^[a-z0-9][a-z0-9-]*$/);
const native = path.join(build, "native-check");
await mkdir(native, { recursive: true });
const fileRoot = "/workspace/" + relative + "/kicad/" + name;
const resultRoot = "/workspace/" + relative + "/native-check";
const image = "kicad/kicad@sha256:3f4a01786dfbe803a65f345c3342b765db9add913f5e9448f8356793714ddc34";

function runKicad(args: string[]): void {
  const mountSource = repo.replaceAll("\\", "/");
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const identity = process.platform === "win32" ? [] : ["--user", uid + ":" + gid, "--env", "HOME=/tmp"];
  const out = spawnSync("docker", [
    "run", "--rm", ...identity, "--network=none",
    "--mount", "type=bind,source=" + mountSource + ",target=/workspace",
    "--workdir", "/workspace/" + relative + "/kicad",
    "--entrypoint", "kicad-cli", image, ...args
  ], { cwd: repo, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000, windowsHide: true });
  if (out.error || out.status !== 0) {
    throw new Error("KICAD_NATIVE_FAILED: " + args.join(" ") + ": " + (out.stderr ?? out.stdout ?? out.error?.message).slice(-2000));
  }
}
runKicad(["sch", "export", "netlist", "--output", resultRoot + "/native.net", fileRoot + ".kicad_sch"]);
runKicad(["sch", "erc", "--format", "json", "--output", resultRoot + "/erc.json", fileRoot + ".kicad_sch"]);
runKicad(createPcbDrcArgs(resultRoot + "/drc.json", fileRoot + ".kicad_pcb"));

const circuit = JSON.parse(await readFile(path.join(build, "circuit.json"), "utf8")) as unknown[];
const source = sourcePinNetGroups(circuit);
const netlist = parseKicadNetlistPinNetGroups(await readFile(path.join(native, "native.net"), "utf8"));
let connectivity = "exact";
let connectivityError: string | null = null;
try { assertPinNetMembership(source, netlist); }
catch (err) { connectivity = "mismatch"; connectivityError = (err as Error).message; }
const erc = JSON.parse(await readFile(path.join(native, "erc.json"), "utf8"));
const drc = JSON.parse(await readFile(path.join(native, "drc.json"), "utf8"));
const ercFindings = (erc.sheets ?? []).flatMap((s: { violations?: unknown[] }) => s.violations ?? []);
const drcEvidence = readPcbDrcEvidence(drc);
const parts = JSON.parse(await readFile(path.join(build, "parts-validation.json"), "utf8"));
const summary = {
  schema_version: 1,
  status: connectivity === "exact" && !ercFindings.length && drcEvidence.findings.length === 0
    ? "all_native_checks_passed" : "connectivity_or_native_findings_present",
  native_pin_net_membership: connectivity === "exact" ? "passed" : "failed",
  parts_verification_status: parts.status,
  fixtures: [{
    fixture: name, pin_net_membership: connectivity,
    connectivity_error: connectivityError,
    source_pin_net_groups: source, native_pin_net_groups: netlist,
    erc_finding_count: ercFindings.length, erc_findings: ercFindings,
    erc_ignored_checks: erc.ignored_checks ?? null,
    pcb_drc_violations: drcEvidence.findings.length,
    pcb_drc_findings: drcEvidence.findings,
    pcb_drc_ignored_checks: drc.ignored_checks ?? null,
    pcb_unconnected_items: drcEvidence.unconnectedItems,
    pcb_schematic_parity_issues: drcEvidence.schematicParityIssues,
  }],
};
const release = checkGeneralNativeRelease(summary, [name], "pcb");
await writeFile(path.join(native, "verification-summary.json"), JSON.stringify({ ...summary, release_gate: release }, null, 2) + "\n");
process.stdout.write(JSON.stringify({
  project: name, connectivity,
  erc: ercFindings.length,
  drc: drcEvidence.violations.length,
  unconnected: drcEvidence.unconnectedItems.length,
  schematic_parity_issues: drcEvidence.schematicParityIssues.length,
  parts_status: parts.status,
  strict_release_ready: release.ready,
  blockers: release.blockers,
  output: path.join(native, "verification-summary.json"),
}, null, 2) + "\n");
if (connectivity !== "exact" || (values.strict && !release.ready)) process.exitCode = 1;
