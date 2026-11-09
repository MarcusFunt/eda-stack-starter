import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { Circuit } from "tscircuit";
import * as circuitJsonSchemas from "circuit-json";
import { normalizeTscircuitCircuitJson } from "./circuit-json-compat.js";

const projectRoot = "/opt/eda/compiler/projects/input";

type SourceFile = { path: string; sha256: string; bytes: number };
type JsonObject = Record<string, unknown>;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listSourceFiles(directory: string, relative = ""): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relative ? relative + "/" + entry.name : entry.name;
    const fullPath = path.join(directory, entry.name);
    const stat = await lstat(fullPath);
    if (stat.isSymbolicLink()) throw new Error("PROJECT_SYMLINK: source tree contains a symbolic link: " + relativePath);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") throw new Error("UNSUPPORTED_DEPENDENCY: project node_modules must not be mounted");
      files.push(...await listSourceFiles(fullPath, relativePath));
      continue;
    }
    if (!entry.isFile()) throw new Error("UNSUPPORTED_SOURCE: source tree contains a non-regular file: " + relativePath);
    const bytes = await readFile(fullPath);
    files.push({ path: relativePath, sha256: sha256(bytes), bytes: bytes.byteLength });
  }
  return files;
}

function validateCircuitJson(circuitJson: unknown): asserts circuitJson is JsonObject[] {
  if (!Array.isArray(circuitJson) || circuitJson.length === 0) {
    throw new Error("INVALID_CIRCUIT_JSON: tscircuit returned an empty or non-array Circuit JSON result");
  }
  for (const [index, value] of circuitJson.entries()) {
    if (!isObject(value) || typeof value.type !== "string") {
      throw new Error("INVALID_CIRCUIT_JSON: record " + index + " has no string type");
    }
    const schemaName = value.type === "source_component" ? "source_" + String(value.ftype ?? "") : value.type;
    const schema = (circuitJsonSchemas as Record<string, unknown>)[schemaName] as
      | { safeParse?: (input: unknown) => { success: boolean; error?: { issues?: Array<{ message: string }> } } }
      | undefined;
    if (typeof schema?.safeParse !== "function") {
      throw new Error("UNSUPPORTED_CIRCUIT_JSON_TYPE: no pinned Circuit JSON schema is available for " + schemaName);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const firstIssue = parsed.error?.issues?.[0];
      const issuePath = firstIssue?.path?.join(".") ?? "";
      const issue = (issuePath ? issuePath + ": " : "") + (firstIssue?.message ?? "schema validation failed");
      throw new Error("INVALID_CIRCUIT_JSON: record " + index + " (" + schemaName + "): " + issue + "; item=" + JSON.stringify(value).slice(0, 500));
    }
  }
}

function classifyError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("UNSUPPORTED_CIRCUIT_JSON_TYPE:")) return { code: "UNSUPPORTED_CIRCUIT_JSON_TYPE", message };
  if (message.startsWith("INVALID_CIRCUIT_JSON:")) return { code: "INVALID_CIRCUIT_JSON", message };
  if (message.startsWith("PROJECT_SYMLINK:") || message.startsWith("UNSUPPORTED_DEPENDENCY:") || message.startsWith("UNSUPPORTED_SOURCE:")) {
    return { code: message.split(":", 1)[0], message };
  }
  if (error instanceof SyntaxError || message.startsWith("Transform failed with ")) return { code: "MALFORMED_TSX", message };
  if (isObject(error) && error.code === "ERR_MODULE_NOT_FOUND") return { code: "MISSING_DEPENDENCY", message };
  return { code: "TSX_RENDER_FAILED", message };
}

async function main(): Promise<void> {
  const [entrypointArgument, outputDirectoryArgument] = process.argv.slice(2);
  if (!entrypointArgument || !outputDirectoryArgument) {
    throw new Error("USAGE: sandbox runner expects <relative-entrypoint> <output-directory>");
  }
  const entrypoint = path.posix.normalize(entrypointArgument.replaceAll("\\", "/"));
  if (entrypoint.startsWith("/") || entrypoint === ".." || entrypoint.startsWith("../")) {
    throw new Error("INVALID_ENTRYPOINT: entrypoint must remain within the mounted project");
  }
  const entrypointPath = path.resolve(projectRoot, ...entrypoint.split("/"));
  if (!entrypointPath.startsWith(projectRoot + path.sep)) {
    throw new Error("INVALID_ENTRYPOINT: entrypoint escaped the mounted project");
  }
  const sourceFiles = await listSourceFiles(projectRoot);
  if (!sourceFiles.some((file) => file.path === entrypoint)) {
    throw new Error("INVALID_ENTRYPOINT: entrypoint was not present in the mounted project: " + entrypoint);
  }

  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as JsonObject;
  if (packageJson.dependencies && isObject(packageJson.dependencies)) {
    for (const [dependency, version] of Object.entries(packageJson.dependencies)) {
      const resolved = JSON.parse(await readFile(path.resolve("/opt/eda/compiler/node_modules", dependency, "package.json"), "utf8")) as JsonObject;
      if (typeof version !== "string" || resolved.version !== version) {
        throw new Error("UNSUPPORTED_DEPENDENCY: project dependency is not in the pinned runtime: " + dependency);
      }
    }
  }

  const moduleUrl = pathToFileURL(entrypointPath).href;
  const loaded = await import(moduleUrl) as { default?: unknown; Board?: unknown };
  const component = loaded.default ?? loaded.Board;
  if (component === undefined) throw new Error("UNSUPPORTED_ENTRYPOINT: export a default board component");
  const boardElement = typeof component === "function" ? React.createElement(component as React.ComponentType) : component;
  if (!React.isValidElement(boardElement)) throw new Error("UNSUPPORTED_ENTRYPOINT: board export must be a React element or component");

  const circuit = new Circuit({ platform: { analogSimulationDisabled: true } });
  circuit.add(boardElement);
  await circuit.renderUntilSettled();
  const normalized = normalizeTscircuitCircuitJson(circuit.getCircuitJson());
  const circuitJson = normalized.circuitJson;
  validateCircuitJson(circuitJson);

  const outputDirectory = path.resolve(outputDirectoryArgument);
  const circuitBytes = Buffer.from(JSON.stringify(circuitJson, null, 2) + "\n");
  const compilerManifest = {
    schema_version: 1,
    project_name: packageJson.name,
    entrypoint,
    source_files: sourceFiles,
    toolchain: {
      node: process.version,
      tscircuit: JSON.parse(await readFile("/opt/eda/compiler/node_modules/tscircuit/package.json", "utf8")).version,
      react: JSON.parse(await readFile("/opt/eda/compiler/node_modules/react/package.json", "utf8")).version,
      compiler_runtime: JSON.parse(await readFile("/opt/eda/compiler/package.json", "utf8")).version,
    },
    circuit_json_sha256: sha256(circuitBytes),
    circuit_json_bytes: circuitBytes.byteLength,
    circuit_json_compatibility_normalizations: normalized.applied,
  };

  await writeFile(path.join(outputDirectory, "circuit.json"), circuitBytes, { flag: "wx" });
  const compilerManifestBytes = Buffer.from(JSON.stringify(compilerManifest, null, 2) + "\n");
  await writeFile(path.join(outputDirectory, "compiler-manifest.json"), compilerManifestBytes, { flag: "wx" });
  const resultEnvelope = Buffer.from(JSON.stringify({
    circuit_json_text: circuitBytes.toString("utf8"),
    compiler_manifest_text: compilerManifestBytes.toString("utf8"),
  }));
  if (resultEnvelope.byteLength > 48 * 1024 * 1024) throw new Error("SANDBOX_OUTPUT_LIMIT: compiler result exceeds 48 MiB");
  const encoded = resultEnvelope.toString("base64");
  const chunkBytes = 48 * 1024;
  const chunkCount = Math.ceil(encoded.length / chunkBytes);
  const resultDigest = sha256(resultEnvelope);
  const writeStdout = async (line: string): Promise<void> => {
    if (!process.stdout.write(line)) await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
  };
  await writeStdout(`EDA_BUILD_RESULT_BEGIN:${chunkCount}:${resultDigest}\n`);
  for (let index = 0; index < chunkCount; index += 1) {
    await writeStdout(`EDA_BUILD_RESULT_CHUNK:${index}:${encoded.slice(index * chunkBytes, (index + 1) * chunkBytes)}\n`);
  }
  await writeStdout(`EDA_BUILD_RESULT_END:${chunkCount}:${resultDigest}\n`);
}

main().catch((error: unknown) => {
  const diagnostic = classifyError(error);
  process.stderr.write(JSON.stringify({ status: "failed", ...diagnostic }) + "\n");
  process.exitCode = 1;
});
