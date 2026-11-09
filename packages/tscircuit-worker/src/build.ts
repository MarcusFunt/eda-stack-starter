import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import * as circuitJsonSchemas from "circuit-json";
import { exportCircuitJsonToKicad } from "./export-kicad.js";
import { sourcePinNetGroups } from "./connectivity.js";
import { CIRCUIT_JSON_COMPAT_NORMALIZATION } from "./circuit-json-compat.js";
import { resolvePartsForBuild } from "./parts-validation.js";

export const PROJECT_SANDBOX_IMAGE = "edastack/tscircuit-project-sandbox:0.1.0";
const PROJECT_SANDBOX_LABEL = "org.edastack.project-sandbox";
const PROJECT_LOCK_LABEL = "org.edastack.compiler-lock-sha256";
const SANDBOX_RUNTIME_VERSION = "0.1.0";
const PROJECT_RUNTIME = { tscircuit: "0.0.3114", react: "19.3.1" } as const;
const MAX_PROJECT_FILES = 256;
const MAX_PROJECT_FILE_BYTES = 256 * 1024;
const MAX_PROJECT_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_CIRCUIT_JSON_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURED_OUTPUT_BYTES = 48 * 1024 * 1024;
const MAX_DOCKER_LOG_BYTES = 1024 * 1024;
const MAX_SANDBOX_LOG_BYTES = 48 * 1024 * 1024;
const SANDBOX_PROTOCOL_CHUNK_BYTES = 48 * 1024;
const DEFAULT_BUILD_TIMEOUT_MS = 60_000;
const projectSchemaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../schemas");
const projectSchemaValidator = new Ajv2020({ allErrors: true, strict: true });
const projectSchemaCache = new Map<string, Promise<ValidateFunction>>();

type JsonObject = Record<string, unknown>;

export type ProjectSourceFile = {
  path: string;
  bytes: Buffer;
  sha256: string;
};

export type ProjectSnapshot = {
  root: string;
  name: string;
  entrypoint: string;
  files: ProjectSourceFile[];
};

export type CanonicalSourceGraph = {
  schema_version: 1;
  components: Array<{
    reference: string;
    component_type: string;
    properties: Record<string, unknown>;
  }>;
  ports: Array<{
    component: string;
    pin: string;
    name: string;
    net_id: string;
  }>;
  nets: Array<{
    id: string;
    names: string[];
    pins: string[];
  }>;
};

export type ProjectBuildOptions = {
  projectRoot: string;
  outputDir: string;
  entrypoint?: string;
  dockerExecutable?: string;
  timeoutMs?: number;
};

export type ProjectBuildResult = {
  projectName: string;
  outputDir: string;
  circuitJsonPath: string;
  sourceGraphPath: string;
  sourceManifestPath: string;
  kicadOutputDir: string;
  manifestPath: string;
  circuitJsonSha256: string;
  componentCount: number;
  netCount: number;
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (!isObject(value)) return JSON.stringify(value);
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}

function safeProjectRelativePath(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new Error(label + " must be a non-empty relative path");
  }
  const portable = value.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (
    portable.startsWith("/") ||
    /^[A-Za-z]:/.test(portable) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(label + " must be relative and remain inside the project root");
  }
  return segments.join("/");
}

function readJsonObject(bytes: Buffer, filename: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(filename + " must contain valid JSON: " + (error as Error).message);
  }
  if (!isObject(parsed)) throw new Error(filename + " must contain a JSON object");
  return parsed;
}

async function validateProjectSchema(schemaFilename: string, filename: string, value: unknown): Promise<void> {
  let pending = projectSchemaCache.get(schemaFilename);
  if (!pending) {
    pending = readFile(path.join(projectSchemaRoot, schemaFilename), "utf8").then((text) =>
      projectSchemaValidator.compile(JSON.parse(text) as object),
    );
    projectSchemaCache.set(schemaFilename, pending);
  }
  let validate: ValidateFunction;
  try {
    validate = await pending;
  } catch (error) {
    projectSchemaCache.delete(schemaFilename);
    throw new Error("PROJECT_SCHEMA_UNAVAILABLE: could not load " + schemaFilename + ": " + (error as Error).message);
  }
  if (!validate(value)) {
    throw new Error("INVALID_PROJECT: " + filename + " does not match schema: " + projectSchemaValidator.errorsText(validate.errors));
  }
}

function validatePackageManifest(bytes: Buffer): string {
  const manifest = readJsonObject(bytes, "package.json");
  const allowedKeys = new Set(["name", "version", "private", "type", "dependencies"]);
  const unsupportedKeys = Object.keys(manifest).filter((key) => !allowedKeys.has(key));
  if (unsupportedKeys.length > 0) {
    throw new Error("UNSUPPORTED_PROJECT_FEATURE: package.json contains unsupported fields: " + unsupportedKeys.join(", "));
  }
  if (typeof manifest.name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(manifest.name)) {
    throw new Error("INVALID_PROJECT: package.json name must be a short portable identifier");
  }
  if (manifest.version !== "1.0.0" || manifest.private !== true || manifest.type !== "module") {
    throw new Error("INVALID_PROJECT: package.json must be private, type module, version 1.0.0");
  }
  if (!isObject(manifest.dependencies)) throw new Error("INVALID_PROJECT: package.json dependencies are required");
  const dependencyNames = Object.keys(manifest.dependencies).sort();
  if (JSON.stringify(dependencyNames) !== JSON.stringify(["react", "tscircuit"])) {
    throw new Error("UNSUPPORTED_DEPENDENCY: projects may use only the pinned react and tscircuit runtime");
  }
  if (manifest.dependencies.react !== PROJECT_RUNTIME.react || manifest.dependencies.tscircuit !== PROJECT_RUNTIME.tscircuit) {
    throw new Error("UNSUPPORTED_DEPENDENCY: project dependencies must exactly match the sandbox runtime pins");
  }
  return manifest.name;
}

type ProjectMetadata = { projectId: string; entrypoint: string };

async function validateProjectMetadata(files: readonly ProjectSourceFile[]): Promise<ProjectMetadata> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const required = ["eda.project.json", "package.json", "requirements.json", "parts.lock.json", "pcb.constraints.json"];
  for (const filename of required) {
    if (!byPath.has(filename)) throw new Error("INVALID_PROJECT: required project file is missing: " + filename);
  }
  const project = readJsonObject(byPath.get("eda.project.json")!.bytes, "eda.project.json");
  await validateProjectSchema("tscircuit-project.schema.json", "eda.project.json", project);
  if (
    project.schema_version !== 1 ||
    typeof project.project_id !== "string" ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(project.project_id) ||
    project.authoring_backend !== "tscircuit" ||
    typeof project.entrypoint !== "string" ||
    project.requirements_file !== "requirements.json" ||
    project.parts_lock !== "parts.lock.json" ||
    project.pcb_constraints_file !== "pcb.constraints.json" ||
    project.toolchain_profile !== "kicad10-ngspice47-tscircuit-pinned" ||
    project.approval_policy !== "human-release"
  ) {
    throw new Error("INVALID_PROJECT: eda.project.json does not match the pinned tscircuit project contract");
  }
  const entrypoint = safeProjectRelativePath(project.entrypoint, "project entrypoint");
  if (!/^src\/.+\.tsx?$/.test(entrypoint)) {
    throw new Error("UNSUPPORTED_ENTRYPOINT: eda.project.json entrypoint must be under src/ and use .ts or .tsx");
  }
  const requirements = readJsonObject(byPath.get("requirements.json")!.bytes, "requirements.json");
  await validateProjectSchema("requirements.schema.json", "requirements.json", requirements);
  if (requirements.schema_version !== 1 || !Array.isArray(requirements.requirements)) {
    throw new Error("INVALID_PROJECT: requirements.json must use schema_version 1 and contain a requirements array");
  }
  const parts = readJsonObject(byPath.get("parts.lock.json")!.bytes, "parts.lock.json");
  await validateProjectSchema("parts-lock.schema.json", "parts.lock.json", parts);
  if (parts.schema_version !== 1 || !Array.isArray(parts.parts)) {
    throw new Error("INVALID_PROJECT: parts.lock.json must use schema_version 1 and contain a parts array");
  }
  const constraints = readJsonObject(byPath.get("pcb.constraints.json")!.bytes, "pcb.constraints.json");
  await validateProjectSchema("pcb-constraints.schema.json", "pcb.constraints.json", constraints);
  if (constraints.schema_version !== 1 || !isObject(constraints.board)) {
    throw new Error("INVALID_PROJECT: pcb.constraints.json must use schema_version 1 and contain a board object");
  }
  return { projectId: project.project_id, entrypoint };
}

export async function snapshotProject(projectRoot: string, entrypointArgument?: string): Promise<ProjectSnapshot> {
  const rootArgument = path.resolve(projectRoot);
  let rootStat;
  try {
    rootStat = await lstat(rootArgument);
  } catch (error) {
    throw new Error("PROJECT_NOT_FOUND: cannot read project root " + rootArgument, { cause: error });
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("INVALID_PROJECT: project root must be a real directory, not a symbolic link");
  }
  const root = await realpath(rootArgument);
  const collected: ProjectSourceFile[] = [];
  let totalBytes = 0;
  async function walk(directory: string, relativeDirectory = ""): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".git" && relativeDirectory === "") continue;
      if (entry.name === "node_modules") throw new Error("UNSUPPORTED_DEPENDENCY: project node_modules must not be mounted");
      if (/^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(entry.name)) {
        throw new Error("UNSUPPORTED_DEPENDENCY: project lockfiles are not used or mounted; declare only the pinned runtime in package.json");
      }
      const relativePath = relativeDirectory ? relativeDirectory + "/" + entry.name : entry.name;
      const portable = safeProjectRelativePath(relativePath, "project file path");
      const fullPath = path.join(directory, entry.name);
      const before = await lstat(fullPath);
      if (before.isSymbolicLink()) throw new Error("PROJECT_SYMLINK: source tree contains a symbolic link: " + portable);
      if (before.isDirectory()) {
        if (portable.split("/").length > 16) throw new Error("PROJECT_LIMIT: project directory nesting exceeds 16 levels");
        await walk(fullPath, portable);
        continue;
      }
      if (!before.isFile()) throw new Error("UNSUPPORTED_SOURCE: project contains a non-regular file: " + portable);
      if ((before.nlink ?? 1) > 1) throw new Error("PROJECT_HARDLINK: hard-linked project files are not supported: " + portable);
      if (!/\.(?:tsx?|json|svg|md|txt)$/i.test(portable)) {
        throw new Error("UNSUPPORTED_SOURCE: project file type is not supported: " + portable);
      }
      if (before.size > MAX_PROJECT_FILE_BYTES) throw new Error("PROJECT_LIMIT: project file exceeds 256 KiB: " + portable);
      const bytes = await readFile(fullPath);
      const after = await lstat(fullPath);
      if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
        throw new Error("PROJECT_CHANGED_DURING_SNAPSHOT: source file identity changed while being copied: " + portable);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_PROJECT_TOTAL_BYTES) throw new Error("PROJECT_LIMIT: project source exceeds 2 MiB");
      collected.push({ path: portable, bytes, sha256: sha256(bytes) });
      if (collected.length > MAX_PROJECT_FILES) throw new Error("PROJECT_LIMIT: project has more than 256 files");
    }
  }
  await walk(root);
  collected.sort((left, right) => left.path.localeCompare(right.path));
  const metadata = await validateProjectMetadata(collected);
  const packageFile = collected.find((file) => file.path === "package.json")!;
  const name = validatePackageManifest(packageFile.bytes);
  if (metadata.projectId !== name) throw new Error("INVALID_PROJECT: eda.project.json project_id must match package.json name");
  const entrypoint = entrypointArgument === undefined
    ? metadata.entrypoint
    : safeProjectRelativePath(entrypointArgument, "entrypoint");
  if (entrypoint !== metadata.entrypoint) throw new Error("INVALID_PROJECT: requested entrypoint must match eda.project.json");
  if (!/\.tsx?$/.test(entrypoint)) throw new Error("UNSUPPORTED_ENTRYPOINT: entrypoint must be a .ts or .tsx file");
  if (!collected.some((file) => file.path === entrypoint)) {
    throw new Error("INVALID_ENTRYPOINT: entrypoint does not exist in the project: " + entrypoint);
  }
  return { root, name, entrypoint, files: collected };
}

function dockerPath(value: string): string {
  const portable = path.resolve(value).replaceAll("\\", "/");
  if (portable.includes(",") || portable.includes("\n") || portable.includes("\r")) {
    throw new Error("UNSUPPORTED_PATH: Docker bind mount paths may not contain commas or newlines");
  }
  return portable;
}

async function resolvePathThroughExistingAncestor(value: string): Promise<string> {
  let current = path.resolve(value);
  const missingSegments: string[] = [];
  while (true) {
    try {
      await lstat(current);
      const realAncestor = await realpath(current);
      return path.resolve(realAncestor, ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

export function createSandboxContainerArgs({
  containerName,
  projectPath,
  entrypoint,
}: {
  containerName: string;
  projectPath: string;
  entrypoint: string;
}): string[] {
  if (!/^edastack-[a-z0-9-]{1,54}$/.test(containerName)) throw new Error("Invalid sandbox container name");
  const safeEntrypoint = safeProjectRelativePath(entrypoint, "entrypoint");
  const projectMount = dockerPath(projectPath);
  return [
    "create",
    "--name=" + containerName,
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--memory=1g",
    "--memory-swap=1g",
    "--cpus=1",
    "--pids-limit=64",
    "--shm-size=16m",
    "--log-driver=json-file",
    "--log-opt=max-size=32m",
    "--log-opt=max-file=1",
    "--ulimit=cpu=45:60",
    "--ulimit=nofile=256:256",
    "--user=65532:65532",
    "--workdir=/opt/eda/compiler/projects/input",
    "--env=NODE_ENV=production",
    "--env=NODE_OPTIONS=--max-old-space-size=512",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532",
    "--tmpfs=/output:rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532",
    "--mount=type=bind,source=" + projectMount + ",target=/opt/eda/compiler/projects/input,readonly",
    PROJECT_SANDBOX_IMAGE,
    safeEntrypoint,
    "/output",
  ];
}

export function validateCircuitJsonSchema(circuitJson: unknown): asserts circuitJson is JsonObject[] {
  if (!Array.isArray(circuitJson) || circuitJson.length === 0) {
    throw new Error("INVALID_CIRCUIT_JSON: expected a non-empty Circuit JSON array");
  }
  for (const [index, value] of circuitJson.entries()) {
    if (!isObject(value) || typeof value.type !== "string") {
      throw new Error("INVALID_CIRCUIT_JSON: record " + index + " must have a string type");
    }
    const schemaName = value.type === "source_component" ? "source_" + String(value.ftype ?? "") : value.type;
    const schema = (circuitJsonSchemas as Record<string, unknown>)[schemaName] as
      | { safeParse?: (input: unknown) => { success: boolean; error?: { issues?: Array<{ message: string }> } } }
      | undefined;
    if (typeof schema?.safeParse !== "function") {
      throw new Error("UNSUPPORTED_CIRCUIT_JSON_TYPE: no pinned Circuit JSON schema exists for " + schemaName);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error?.issues?.[0]?.message ?? "schema validation failed";
      throw new Error("INVALID_CIRCUIT_JSON: record " + index + " (" + schemaName + "): " + issue);
    }
  }
}

export function parseSandboxFailureDiagnostic(logs: string): { code: string; message: string } | undefined {
  for (const line of logs.split(/\r?\n/).reverse()) {
    if (line.length > 16_384) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      isObject(parsed) &&
      parsed.status === "failed" &&
      typeof parsed.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(parsed.code) &&
      typeof parsed.message === "string"
    ) {
      return { code: parsed.code, message: parsed.message.slice(0, 8_000) };
    }
  }
  return undefined;
}

function sortedProperties(value: JsonObject): Record<string, unknown> {
  const excluded = new Set(["type", "source_component_id", "subcircuit_id", "name", "ftype"]);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (!excluded.has(key) && !key.endsWith("_id")) output[key] = JSON.parse(canonicalJson(value[key]));
  }
  return output;
}

export function canonicalSourceGraph(circuitJson: readonly unknown[]): CanonicalSourceGraph {
  const groups = sourcePinNetGroups(circuitJson);
  const sortedGroups = [...groups].sort((left, right) => left.pins.join("\u0000").localeCompare(right.pins.join("\u0000")));
  const nets = sortedGroups.map((group, index) => ({
    id: "N" + String(index + 1).padStart(3, "0"),
    names: [...group.netNames].sort(),
    pins: [...group.pins].sort(),
  }));
  const netByPin = new Map(nets.flatMap((net) => net.pins.map((pin) => [pin, net.id] as const)));
  const records = circuitJson.filter((item): item is JsonObject => isObject(item));
  const componentsById = new Map<string, JsonObject>();
  const components = records.filter((item) => item.type === "source_component");
  for (const component of components) {
    if (typeof component.source_component_id !== "string" || typeof component.name !== "string" || typeof component.ftype !== "string") {
      throw new Error("INVALID_CIRCUIT_JSON: source component identity, name, and ftype are required");
    }
    componentsById.set(component.source_component_id, component);
  }
  const canonicalComponents = components.map((component) => ({
    reference: String(component.name),
    component_type: String(component.ftype),
    properties: sortedProperties(component),
  })).sort((left, right) => left.reference.localeCompare(right.reference));
  const ports = records.filter((item) => item.type === "source_port").map((port) => {
    const component = typeof port.source_component_id === "string" ? componentsById.get(port.source_component_id) : undefined;
    if (!component || typeof component.name !== "string") throw new Error("INVALID_CIRCUIT_JSON: source port references an unknown component");
    const pin = String(port.pin_number);
    const membership = String(component.name) + ":" + pin;
    const netId = netByPin.get(membership);
    if (!netId || typeof port.name !== "string") throw new Error("INVALID_CIRCUIT_JSON: source port has no canonical graph membership");
    return { component: String(component.name), pin, name: port.name, net_id: netId };
  }).sort((left, right) => left.component.localeCompare(right.component) || Number(left.pin) - Number(right.pin));

  return { schema_version: 1, components: canonicalComponents, ports, nets };
}

async function sandboxPackageLock(): Promise<{ root: string; sha256: string }> {
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  const workerRoot = path.resolve(sourceDirectory, "..");
  const compilerRoot = path.resolve(workerRoot, "..", "tscircuit-compiler");
  const lockBytes = await readFile(path.join(compilerRoot, "package-lock.json"));
  return { root: compilerRoot, sha256: sha256(lockBytes) };
}

function dockerCommand(
  executable: string,
  arguments_: string[],
  timeoutMs: number,
  maxBuffer = MAX_DOCKER_LOG_BYTES,
): ReturnType<typeof spawnSync> {
  return spawnSync(executable, arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer,
    windowsHide: true,
  });
}

async function inspectSandboxImage(dockerExecutable: string): Promise<{ imageId: string; lockSha256: string }> {
  const lock = await sandboxPackageLock();
  const result = dockerCommand(
    dockerExecutable,
    ["image", "inspect", "--format", "{{json .Config.Labels}}", PROJECT_SANDBOX_IMAGE],
    10_000,
  );
  if (result.error || result.status !== 0) {
    throw new Error("SANDBOX_IMAGE_MISSING: build the pinned tscircuit image with npm run sandbox:image before compiling projects");
  }
  let labels: Record<string, string>;
  try {
    labels = JSON.parse(String(result.stdout ?? "null")) as Record<string, string>;
  } catch (error) {
    throw new Error("SANDBOX_IMAGE_INVALID: could not read sandbox image labels", { cause: error });
  }
  if (labels?.[PROJECT_SANDBOX_LABEL] !== "tscircuit-v1" || labels?.[PROJECT_LOCK_LABEL] !== lock.sha256) {
    throw new Error("SANDBOX_IMAGE_STALE: sandbox image labels do not match the pinned compiler lockfile; rebuild the image");
  }
  const imageResult = dockerCommand(dockerExecutable, ["image", "inspect", "--format", "{{.Id}}", PROJECT_SANDBOX_IMAGE], 10_000);
  if (imageResult.error || imageResult.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(String(imageResult.stdout ?? "").trim())) {
    throw new Error("SANDBOX_IMAGE_INVALID: Docker did not return a valid sandbox image ID");
  }
  return { imageId: String(imageResult.stdout).trim(), lockSha256: lock.sha256 };
}

async function writeProjectSnapshot(snapshot: ProjectSnapshot, destination: string): Promise<void> {
  await mkdir(destination, { recursive: false });
  for (const file of snapshot.files) {
    const outputPath = path.join(destination, ...file.path.split("/"));
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, file.bytes, { flag: "wx", mode: 0o444 });
  }
}

export function parseSandboxResultLogs(logs: string): { circuitBytes: Buffer; compilerManifestBytes: Buffer } {
  if (Buffer.byteLength(logs) > MAX_SANDBOX_LOG_BYTES) throw new Error("SANDBOX_OUTPUT_LIMIT: captured container logs exceed 48 MiB");
  const lines = logs.split(/\r?\n/);
  const begin = lines.find((line) => line.startsWith("EDA_BUILD_RESULT_BEGIN:"));
  const end = lines.find((line) => line.startsWith("EDA_BUILD_RESULT_END:"));
  if (!begin || !end) throw new Error("SANDBOX_OUTPUT_INVALID: compiler result protocol markers are missing");
  const beginMatch = begin.match(/^EDA_BUILD_RESULT_BEGIN:(\d+):([a-f0-9]{64})$/);
  const endMatch = end.match(/^EDA_BUILD_RESULT_END:(\d+):([a-f0-9]{64})$/);
  if (!beginMatch || !endMatch || beginMatch[1] !== endMatch[1] || beginMatch[2] !== endMatch[2]) {
    throw new Error("SANDBOX_OUTPUT_INVALID: compiler result protocol markers do not match");
  }
  const count = Number(beginMatch[1]);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000) throw new Error("SANDBOX_OUTPUT_LIMIT: compiler result has an invalid chunk count");
  const chunks = new Map<number, string>();
  for (const line of lines) {
    const match = line.match(/^EDA_BUILD_RESULT_CHUNK:(\d+):([A-Za-z0-9+/=]+)$/);
    if (!match) continue;
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count || chunks.has(index)) {
      throw new Error("SANDBOX_OUTPUT_INVALID: compiler result has a duplicate or invalid chunk index");
    }
    chunks.set(index, match[2]);
  }
  if (chunks.size !== count) throw new Error("SANDBOX_OUTPUT_INVALID: compiler result is missing one or more chunks");
  const encoded = Array.from({ length: count }, (_, index) => chunks.get(index)!).join("");
  const bundleBytes = Buffer.from(encoded, "base64");
  if (bundleBytes.byteLength > MAX_CAPTURED_OUTPUT_BYTES || bundleBytes.toString("base64") !== encoded) {
    throw new Error("SANDBOX_OUTPUT_INVALID: compiler result is oversized or not canonical base64");
  }
  if (sha256(bundleBytes) !== beginMatch[2]) throw new Error("SANDBOX_OUTPUT_INVALID: compiler result digest mismatch");
  let bundle: unknown;
  try {
    bundle = JSON.parse(bundleBytes.toString("utf8"));
  } catch (error) {
    throw new Error("SANDBOX_OUTPUT_INVALID: compiler result envelope is malformed", { cause: error });
  }
  if (!isObject(bundle) || typeof bundle.circuit_json_text !== "string" || typeof bundle.compiler_manifest_text !== "string") {
    throw new Error("SANDBOX_OUTPUT_INVALID: compiler result envelope is missing Circuit JSON or its manifest");
  }
  const circuitBytes = Buffer.from(bundle.circuit_json_text);
  const compilerManifestBytes = Buffer.from(bundle.compiler_manifest_text);
  if (circuitBytes.byteLength > MAX_CIRCUIT_JSON_BYTES) throw new Error("SANDBOX_OUTPUT_LIMIT: Circuit JSON exceeds 16 MiB");
  return { circuitBytes, compilerManifestBytes };
}

function validateCompilerManifest(value: unknown, snapshot: ProjectSnapshot, circuitBytes: Buffer): JsonObject {
  if (!isObject(value) || value.schema_version !== 1 || value.project_name !== snapshot.name || value.entrypoint !== snapshot.entrypoint) {
    throw new Error("SANDBOX_OUTPUT_INVALID: compiler manifest identity does not match the requested project");
  }
  if (!Array.isArray(value.source_files)) throw new Error("SANDBOX_OUTPUT_INVALID: compiler manifest has no source file hashes");
  const actualFiles = value.source_files.map((file) => {
    if (!isObject(file) || typeof file.path !== "string" || typeof file.sha256 !== "string" || typeof file.bytes !== "number") {
      throw new Error("SANDBOX_OUTPUT_INVALID: compiler manifest contains an invalid source file record");
    }
    return { path: file.path, sha256: file.sha256, bytes: file.bytes };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const expectedFiles = snapshot.files.map(({ path: sourcePath, sha256: hash, bytes }) => ({
    path: sourcePath,
    sha256: hash,
    bytes: bytes.byteLength,
  }));
  if (canonicalJson(actualFiles) !== canonicalJson(expectedFiles)) {
    throw new Error("SANDBOX_OUTPUT_INVALID: compiler source hashes do not match the read-only host snapshot");
  }
  if (value.circuit_json_sha256 !== sha256(circuitBytes) || value.circuit_json_bytes !== circuitBytes.byteLength) {
    throw new Error("SANDBOX_OUTPUT_INVALID: compiler manifest Circuit JSON digest does not match its artifact");
  }
  if (!isObject(value.toolchain) || value.toolchain.tscircuit !== PROJECT_RUNTIME.tscircuit || value.toolchain.react !== PROJECT_RUNTIME.react) {
    throw new Error("SANDBOX_OUTPUT_INVALID: compiler toolchain differs from the pinned project runtime");
  }
  if (
    !Array.isArray(value.circuit_json_compatibility_normalizations) ||
    value.circuit_json_compatibility_normalizations.some((normalization) => normalization !== CIRCUIT_JSON_COMPAT_NORMALIZATION)
  ) {
    throw new Error("SANDBOX_OUTPUT_INVALID: compiler reported an unsupported Circuit JSON compatibility normalization");
  }
  return value;
}

async function hashArtifactTree(directory: string): Promise<Record<string, { sha256: string; bytes: number }>> {
  const results: Record<string, { sha256: string; bytes: number }> = {};
  async function walk(current: string, relative = ""): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relative ? relative + "/" + entry.name : entry.name;
      const fullPath = path.join(current, entry.name);
      const fileStat = await lstat(fullPath);
      if (fileStat.isSymbolicLink()) throw new Error("BUILD_ARTIFACT_INVALID: artifact output contains a symlink: " + relativePath);
      if (entry.isDirectory()) {
        await walk(fullPath, relativePath);
      } else if (entry.isFile()) {
        const bytes = await readFile(fullPath);
        results[relativePath] = { sha256: sha256(bytes), bytes: bytes.byteLength };
      } else {
        throw new Error("BUILD_ARTIFACT_INVALID: artifact output contains a non-regular file: " + relativePath);
      }
    }
  }
  await walk(directory);
  return results;
}

async function removeContainer(dockerExecutable: string, containerName: string): Promise<void> {
  dockerCommand(dockerExecutable, ["rm", "--force", containerName], 10_000);
}

export async function buildProject(options: ProjectBuildOptions): Promise<ProjectBuildResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("BUILD_LIMIT: timeoutMs must be between 1000 and 120000");
  }
  const snapshot = await snapshotProject(options.projectRoot, options.entrypoint);
  const outputDir = await resolvePathThroughExistingAncestor(options.outputDir);
  if (isWithinDirectory(snapshot.root, outputDir)) {
    throw new Error("INVALID_OUTPUT: output directory must remain outside the source project");
  }
  const dockerExecutable = options.dockerExecutable ?? "docker";
  const image = await inspectSandboxImage(dockerExecutable);
  const outputParent = path.dirname(outputDir);
  await mkdir(outputParent, { recursive: true });
  try {
    await lstat(outputDir);
    throw new Error("OUTPUT_EXISTS: refusing to replace existing project build artifacts");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // The destination is reserved by the final atomic rename.
    } else {
      throw error;
    }
  }

  const stagingRoot = await mkdtemp(path.join(outputParent, "." + path.basename(outputDir) + ".staging-"));
  const snapshotPath = path.join(stagingRoot, "project-snapshot");
  const capturedPath = path.join(stagingRoot, "captured-output");
  const resultPath = path.join(stagingRoot, "result");
  const containerName = "edastack-tsci-" + randomUUID().replaceAll("-", "").slice(0, 32);
  await writeProjectSnapshot(snapshot, snapshotPath);
  await mkdir(capturedPath);
  await mkdir(resultPath);

  let containerCreated = false;
  try {
    const createArgs = createSandboxContainerArgs({ containerName, projectPath: snapshotPath, entrypoint: snapshot.entrypoint });
    const created = dockerCommand(dockerExecutable, createArgs, 15_000, MAX_DOCKER_LOG_BYTES);
    if (created.error || created.status !== 0) {
      throw new Error("SANDBOX_CREATE_FAILED: " + (created.stderr ?? created.error?.message ?? "Docker could not create a constrained project container"));
    }
    containerCreated = true;
    const started = dockerCommand(dockerExecutable, ["start", "--attach", containerName], timeoutMs, MAX_SANDBOX_LOG_BYTES);
    if ((started.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      throw new Error("BUILD_TIMEOUT: project TSX exceeded the " + timeoutMs + " ms execution limit");
    }
    if (started.error || started.status !== 0) {
      const errorCode = (started.error as NodeJS.ErrnoException | undefined)?.code;
      if (errorCode === "ENOBUFS") throw new Error("SANDBOX_OUTPUT_LIMIT: container logs exceeded the 48 MiB capture limit");
      const details = String(started.stdout ?? "") + String(started.stderr ?? "");
      const diagnostic = parseSandboxFailureDiagnostic(details);
      if (diagnostic) throw new Error(diagnostic.code + ": " + diagnostic.message);
      throw new Error("SANDBOX_START_FAILED: " + (details.trim() || started.error?.message || "Docker could not start the project container"));
    }
    const finalState = dockerCommand(dockerExecutable, ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", containerName], 5_000);
    if (finalState.error || finalState.status !== 0 || !String(finalState.stdout ?? "").trim().startsWith("exited 0")) {
      const logs = dockerCommand(dockerExecutable, ["logs", containerName], 10_000, MAX_SANDBOX_LOG_BYTES);
      const details = String(logs.stdout ?? "") + String(logs.stderr ?? "");
      const diagnostic = parseSandboxFailureDiagnostic(details);
      if (diagnostic) throw new Error(diagnostic.code + ": " + diagnostic.message);
      throw new Error("SANDBOX_BUILD_FAILED: " + (details.trim().slice(-8_000) || "container exited without a successful result"));
    }
    const logs = dockerCommand(dockerExecutable, ["logs", containerName], 15_000, MAX_SANDBOX_LOG_BYTES);
    if (logs.error || logs.status !== 0) throw new Error("SANDBOX_OUTPUT_INVALID: could not read the bounded compiler result log");
    const { circuitBytes, compilerManifestBytes } = parseSandboxResultLogs(String(logs.stdout ?? "") + String(logs.stderr ?? ""));
    let circuitJson: unknown;
    let compilerManifestRaw: unknown;
    try {
      circuitJson = JSON.parse(circuitBytes.toString("utf8"));
      compilerManifestRaw = JSON.parse(compilerManifestBytes.toString("utf8"));
    } catch (error) {
      throw new Error("SANDBOX_OUTPUT_INVALID: runtime returned malformed JSON: " + (error as Error).message);
    }
    validateCompilerManifest(compilerManifestRaw, snapshot, circuitBytes);
    validateCircuitJsonSchema(circuitJson);
    const graph = canonicalSourceGraph(circuitJson);
    const partsLockBytes = snapshot.files.find((file) => file.path === "parts.lock.json")!.bytes;
    const partsResult = await resolvePartsForBuild(circuitJson as unknown[], partsLockBytes, path.join(projectSchemaRoot, "..", "models", "vendor-catalog.json"));
    const partsResultBytes = Buffer.from(JSON.stringify(partsResult, null, 2) + "\n");
    const graphBytes = Buffer.from(JSON.stringify(graph, null, 2) + "\n");
    const sourceManifest = {
      schema_version: 1,
      project_name: snapshot.name,
      entrypoint: snapshot.entrypoint,
      source_files: snapshot.files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes.byteLength })),
      canonical_source_graph: graph,
      circuit_json_sha256: sha256(circuitBytes),
      canonical_source_graph_sha256: sha256(graphBytes),
    };
    await writeFile(path.join(resultPath, "circuit.json"), circuitBytes, { flag: "wx" });
    await writeFile(path.join(resultPath, "compiler-manifest.json"), compilerManifestBytes, { flag: "wx" });
    await writeFile(path.join(resultPath, "source-graph.json"), graphBytes, { flag: "wx" });
    await writeFile(path.join(resultPath, "parts-validation.json"), partsResultBytes, { flag: "wx" });
    const sourceManifestBytes = Buffer.from(JSON.stringify(sourceManifest, null, 2) + "\n");
    await writeFile(path.join(resultPath, "source-manifest.json"), sourceManifestBytes, { flag: "wx" });

    const circuitJsonArray = circuitJson as unknown[];
    const exportResult = await exportCircuitJsonToKicad({
      circuitJson: circuitJsonArray,
      outputDir: path.join(resultPath, "kicad"),
      projectName: snapshot.name,
    });
    const artifactHashes = await hashArtifactTree(resultPath);
    const workerPackage = JSON.parse(await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as JsonObject;
    const buildManifest = {
      schema_version: 1,
      status: "compiled",
      project_name: snapshot.name,
      entrypoint: snapshot.entrypoint,
      created_at_utc: new Date().toISOString(),
      source_files: sourceManifest.source_files,
      source_graph_counts: {
        components: graph.components.length,
        ports: graph.ports.length,
        nets: graph.nets.length,
      },
      toolchain: {
        node: String((compilerManifestRaw as JsonObject).toolchain && ((compilerManifestRaw as JsonObject).toolchain as JsonObject).node),
        tscircuit: PROJECT_RUNTIME.tscircuit,
        react: PROJECT_RUNTIME.react,
        compiler_runtime: SANDBOX_RUNTIME_VERSION,
        compiler_lock_sha256: image.lockSha256,
        sandbox_image: image.imageId,
        circuit_json_to_kicad: "0.0.270",
        worker: workerPackage.version,
      },
      circuit_json_sha256: sha256(circuitBytes),
      source_graph_sha256: sha256(graphBytes),
      parts_verification: { status: partsResult.status, unresolved: partsResult.unresolved.length, sha256: sha256(partsResultBytes) },
      kicad_export_files: exportResult.files.map((filename) => "kicad/" + filename),
      artifacts: artifactHashes,
    };
    await writeFile(path.join(resultPath, "build-manifest.json"), JSON.stringify(buildManifest, null, 2) + "\n", { flag: "wx" });
    await rename(resultPath, outputDir);
    return {
      projectName: snapshot.name,
      outputDir,
      circuitJsonPath: path.join(outputDir, "circuit.json"),
      sourceGraphPath: path.join(outputDir, "source-graph.json"),
      sourceManifestPath: path.join(outputDir, "source-manifest.json"),
      kicadOutputDir: path.join(outputDir, "kicad"),
      manifestPath: path.join(outputDir, "build-manifest.json"),
      circuitJsonSha256: sha256(circuitBytes),
      componentCount: graph.components.length,
      netCount: graph.nets.length,
    };
  } finally {
    if (containerCreated) await removeContainer(dockerExecutable, containerName);
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function buildSandboxImage(dockerExecutable = "docker"): Promise<void> {
  const lock = await sandboxPackageLock();
  const result = dockerCommand(
    dockerExecutable,
    [
      "build",
      "--pull",
      "--build-arg",
      "compiler_lock_sha256=" + lock.sha256,
      "--file",
      path.join(lock.root, "Dockerfile"),
      "--tag",
      PROJECT_SANDBOX_IMAGE,
      lock.root,
    ],
    600_000,
    8 * 1024 * 1024,
  );
  if (result.error || result.status !== 0) {
    throw new Error("SANDBOX_IMAGE_BUILD_FAILED: " + (result.stderr ?? result.error?.message ?? "docker build failed"));
  }
}
