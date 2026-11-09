import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  buildProject,
  createSandboxContainerArgs,
  parseSandboxFailureDiagnostic,
  parseSandboxResultLogs,
  snapshotProject,
  validateCircuitJsonSchema,
} from "../src/build.js";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";

const temporaryDirectories: string[] = [];

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "edastack-project-test-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "test-board",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: { react: "19.3.1", tscircuit: "0.0.3114" },
    }),
  );
  await writeFile(path.join(root, "requirements.json"), JSON.stringify({ schema_version: 1, requirements: [] }));
  await writeFile(path.join(root, "parts.lock.json"), JSON.stringify({ schema_version: 1, status: "unverified", parts: [] }));
  await writeFile(path.join(root, "pcb.constraints.json"), JSON.stringify({ schema_version: 1, board: {} }));
  await writeFile(path.join(root, "eda.project.json"), JSON.stringify({
    schema_version: 1,
    project_id: "test-board",
    authoring_backend: "tscircuit",
    entrypoint: "src/board.tsx",
    requirements_file: "requirements.json",
    parts_lock: "parts.lock.json",
    pcb_constraints_file: "pcb.constraints.json",
    toolchain_profile: "kicad10-ngspice47-tscircuit-pinned",
    approval_policy: "human-release",
  }));
  await writeFile(path.join(root, "src", "board.tsx"), "export default () => null;\n");
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("project snapshots pin the compiler runtime and hash every safe project source", async () => {
  const root = await makeProject();
  await writeFile(path.join(root, "src", "module.tsx"), "export const A = 1;\n");

  const snapshot = await snapshotProject(root, "src/board.tsx");

  assert.equal(snapshot.name, "test-board");
  assert.equal(snapshot.entrypoint, "src/board.tsx");
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    ["eda.project.json", "package.json", "parts.lock.json", "pcb.constraints.json", "requirements.json", "src/board.tsx", "src/module.tsx"],
  );
  assert.ok(snapshot.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
});

test("project snapshots reject an entrypoint that escapes the project root", async () => {
  const root = await makeProject();
  await assert.rejects(snapshotProject(root, "../outside.tsx"), /entrypoint.*relative|escapes/i);
});

test("project snapshots reject dependency installs", async () => {
  const root = await makeProject();
  await mkdir(path.join(root, "node_modules"));
  await assert.rejects(snapshotProject(root, "src/board.tsx"), /node_modules|dependencies/i);
});

test("project snapshots require a matching eda.project.json contract", async () => {
  const root = await makeProject();
  await rm(path.join(root, "eda.project.json"));
  await assert.rejects(snapshotProject(root), /INVALID_PROJECT: required project file is missing: eda.project.json/);
});

test("project snapshots reject fields outside the project manifest schema", async () => {
  const root = await makeProject();
  const projectPath = path.join(root, "eda.project.json");
  const manifest = JSON.parse(await readFile(projectPath, "utf8"));
  manifest.unreviewed_feature = true;
  await writeFile(projectPath, JSON.stringify(manifest));

  await assert.rejects(snapshotProject(root), /INVALID_PROJECT: eda\.project\.json does not match schema/);
});

test("project snapshots validate each requirement against its schema", async () => {
  const root = await makeProject();
  await writeFile(path.join(root, "requirements.json"), JSON.stringify({
    schema_version: 1,
    requirements: [{ id: "voltage", description: "", unreviewed_field: true }],
  }));

  await assert.rejects(snapshotProject(root), /INVALID_PROJECT: requirements\.json does not match schema/);
});

test("project snapshots reject part locks outside their schema", async () => {
  const root = await makeProject();
  await writeFile(path.join(root, "parts.lock.json"), JSON.stringify({
    schema_version: 1,
    status: "unverified",
    parts: [{ reference: "R1", manufacturer_part_number: null, pin_map_status: "unverified", footprint: "0603", hidden: true }],
  }));

  await assert.rejects(snapshotProject(root), /INVALID_PROJECT: parts\.lock\.json does not match schema/);
});

test("project snapshots reject invalid PCB constraints", async () => {
  const root = await makeProject();
  await writeFile(path.join(root, "pcb.constraints.json"), JSON.stringify({
    schema_version: 1,
    board: { width_mm: -1 },
  }));

  await assert.rejects(snapshotProject(root), /INVALID_PROJECT: pcb\.constraints\.json does not match schema/);
});

test("project snapshots reject unused package lockfiles", async () => {
  const root = await makeProject();
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));

  await assert.rejects(snapshotProject(root), /UNSUPPORTED_DEPENDENCY: project lockfiles are not used or mounted/);
});

test("project snapshots reject dependencies outside the exact compiler runtime pins", async () => {
  const root = await makeProject();
  const packagePath = path.join(root, "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  manifest.dependencies.leftPad = "1.3.0";
  await writeFile(packagePath, JSON.stringify(manifest));

  await assert.rejects(snapshotProject(root), /UNSUPPORTED_DEPENDENCY: projects may use only the pinned react and tscircuit runtime/);
});

test("unsupported Circuit JSON record types fail explicitly", () => {
  assert.throws(
    () => validateCircuitJsonSchema([{ type: "source_unreviewed_thing" }]),
    /UNSUPPORTED_CIRCUIT_JSON_TYPE: no pinned Circuit JSON schema exists/,
  );
});

test("build manifest schema accepts the parts verification emitted by project builds", async () => {
  const schema = JSON.parse(await readFile(new URL("../../../schemas/tscircuit-build-manifest.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date-time", (value: string) => !Number.isNaN(Date.parse(value)));
  const validator = ajv.compile(schema);
  const manifest = {
    schema_version: 1,
    status: "compiled",
    project_name: "test-board",
    entrypoint: "src/board.tsx",
    created_at_utc: new Date().toISOString(),
    source_files: [],
    source_graph_counts: { components: 1, ports: 1, nets: 1 },
    toolchain: {
      node: "v24.15.0", tscircuit: "0.0.3114", react: "19.3.1", compiler_runtime: "0.1.0",
      compiler_lock_sha256: "a".repeat(64), sandbox_image: "sha256:" + "b".repeat(64),
      circuit_json_to_kicad: "0.0.270", worker: "0.1.0",
    },
    circuit_json_sha256: "c".repeat(64),
    source_graph_sha256: "d".repeat(64),
    parts_verification: { status: "verified", unresolved: 0, sha256: "e".repeat(64) },
    kicad_export_files: [],
    artifacts: {},
  };
  assert.equal(validator(manifest), true, ajv.errorsText(validator.errors));
});

test("sandbox runner diagnostics preserve explicit failure codes", () => {
  assert.deepEqual(
    parseSandboxFailureDiagnostic([
      "tscircuit debug output",
      JSON.stringify({ status: "failed", code: "MALFORMED_TSX", message: "unexpected token" }),
    ].join("\n")),
    { code: "MALFORMED_TSX", message: "unexpected token" },
  );
  assert.equal(parseSandboxFailureDiagnostic("no structured diagnostic"), undefined);
});

test("project snapshots reject symbolic links", { skip: process.platform === "win32" }, async () => {
  const root = await makeProject();
  await rm(path.join(root, "node_modules"), { recursive: true, force: true });
  await symlink(path.join(root, "src", "board.tsx"), path.join(root, "src", "linked.tsx"));
  await assert.rejects(snapshotProject(root, "src/board.tsx"), /symbolic link|symlink/i);
});

test("build output containment is case-insensitive on Windows", { skip: process.platform !== "win32" }, async () => {
  const root = await makeProject();
  await assert.rejects(
    buildProject({ projectRoot: root, outputDir: path.join(root.toUpperCase(), "generated-build"), dockerExecutable: process.execPath }),
    /INVALID_OUTPUT: output directory must remain outside the source project/,
  );
});

test("sandbox Docker arguments constrain code and expose only read-only source plus bounded scratch", () => {
  const args = createSandboxContainerArgs({
    containerName: "edastack-build-test",
    projectPath: "C:/safe/project",
    entrypoint: "src/board.tsx",
  });

  assert.equal(args[0], "create");
  assert.ok(args.includes("--network=none"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("--pids-limit=64"));
  assert.ok(args.includes("--memory=1g"));
  assert.ok(args.includes("--cpus=1"));
  assert.ok(args.includes("--security-opt=no-new-privileges:true"));
  assert.ok(args.some((argument) => argument.includes("target=/opt/eda/compiler/projects/input,readonly")));
  assert.ok(args.includes("--tmpfs=/output:rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532"));
  assert.equal(args.some((argument) => argument.toLowerCase().includes("docker.sock")), false);
});

test("sandbox result protocol validates and reconstructs its bounded payload", () => {
  const envelope = JSON.stringify({ circuit_json_text: "[]\n", compiler_manifest_text: "{}\n" });
  const digest = createHash("sha256").update(Buffer.from(envelope)).digest("hex");
  const encoded = Buffer.from(envelope).toString("base64");
  const logs = [
    "diagnostic from tscircuit",
    `EDA_BUILD_RESULT_BEGIN:1:${digest}`,
    `EDA_BUILD_RESULT_CHUNK:0:${encoded}`,
    `EDA_BUILD_RESULT_END:1:${digest}`,
  ].join("\n");
  const result = parseSandboxResultLogs(logs);

  assert.equal(result.circuitBytes.toString(), "[]\n");
  assert.equal(result.compilerManifestBytes.toString(), "{}\n");
});

test("sandbox result protocol rejects missing or tampered chunks", () => {
  assert.throws(() => parseSandboxResultLogs("no result"), /protocol markers/);
  assert.throws(
    () => parseSandboxResultLogs(`EDA_BUILD_RESULT_BEGIN:1:${"a".repeat(64)}\nEDA_BUILD_RESULT_CHUNK:0:AA==\nEDA_BUILD_RESULT_END:1:${"a".repeat(64)}`),
    /digest mismatch/,
  );
});
