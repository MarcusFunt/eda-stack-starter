import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CircuitJsonToKicadLibraryConverter,
  CircuitJsonToKicadPcbConverter,
  CircuitJsonToKicadProConverter,
  CircuitJsonToKicadSchConverter,
} from "circuit-json-to-kicad";
import { assertPinNetMembership, sourcePinNetGroups, type PinNetGroup } from "./connectivity.js";

const CONVERTER_PACKAGE = "circuit-json-to-kicad";
const EXPECTED_CONVERTER_VERSION = "0.0.270";

export type ExportKicadOptions = {
  circuitJson: readonly unknown[];
  outputDir: string;
  projectName: string;
};

export type ExportKicadResult = {
  outputDir: string;
  files: string[];
  circuitJsonSha256: string;
  sourcePinNetGroups: PinNetGroup[];
};

function validateProjectName(projectName: string): void {
  if (typeof projectName !== "string" || !/^[A-Za-z0-9_-]+$/.test(projectName)) {
    throw new Error("KiCad project name must contain only letters, numbers, underscores, or hyphens");
  }
}

function validateCircuitJson(circuitJson: readonly unknown[]): PinNetGroup[] {
  if (!Array.isArray(circuitJson) || circuitJson.length === 0) {
    throw new Error("Circuit JSON must be a non-empty array");
  }
  return sourcePinNetGroups(circuitJson);
}

function normalizeArtifactPath(filename: string): string {
  if (typeof filename !== "string" || filename.trim().length === 0) {
    throw new Error("KiCad converter returned an artifact without a filename");
  }
  const portable = filename.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (
    portable.startsWith("/") ||
    /^[A-Za-z]:/.test(portable) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("KiCad converter returned an unsafe artifact path: " + filename);
  }
  return segments.join("/");
}

function addArtifact(artifacts: Map<string, string>, filename: string, content: string): void {
  const normalized = normalizeArtifactPath(filename);
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("KiCad converter returned empty content for " + normalized);
  }
  if (artifacts.has(normalized)) throw new Error("KiCad converter returned duplicate artifact path " + normalized);
  artifacts.set(normalized, content);
}

function matchingClose(text: string, start: number): number {
  if (text[start] !== "(") throw new Error("Expected a KiCad S-expression at offset " + start);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error("Unbalanced KiCad schematic S-expression");
}

function directChildForms(form: string): string[] {
  const formEnd = matchingClose(form, 0);
  const children: string[] = [];
  let cursor = 1;
  while (cursor < formEnd - 1 && !/\s/.test(form[cursor] ?? "")) cursor += 1;
  while (cursor < formEnd - 1) {
    while (/\s/.test(form[cursor] ?? "")) cursor += 1;
    if (cursor >= formEnd - 1) break;
    if (form[cursor] !== "(") throw new Error("Unexpected atom in KiCad symbol library section");
    const childEnd = matchingClose(form, cursor);
    children.push(form.slice(cursor, childEnd));
    cursor = childEnd;
  }
  return children;
}

function quotedSymbolName(form: string): string {
  const match = form.match(/^\(symbol\s+("(?:\\.|[^"\\])*")/);
  if (!match) throw new Error("Embedded KiCad symbol is missing its quoted name");
  return JSON.parse(match[1]) as string;
}

function portableSymbolLibraries(schematics: readonly string[]): { files: Map<string, string>; table: string } {
  const symbolsByLibrary = new Map<string, Map<string, string>>();
  for (const schematic of schematics) {
    const sectionStart = schematic.indexOf("(lib_symbols");
    if (sectionStart < 0) throw new Error("KiCad schematic is missing embedded library symbols");
    const sectionEnd = matchingClose(schematic, sectionStart);
    const section = schematic.slice(sectionStart, sectionEnd);
    for (const symbolForm of directChildForms(section).filter((child) => child.startsWith("(symbol "))) {
      const fullName = quotedSymbolName(symbolForm);
      const separator = fullName.indexOf(":");
      if (separator <= 0 || separator === fullName.length - 1) {
        throw new Error("Unsupported embedded KiCad symbol identifier " + fullName);
      }
      const libraryName = fullName.slice(0, separator);
      const symbolName = fullName.slice(separator + 1);
      if (!/^[A-Za-z0-9_.-]+$/.test(libraryName) || !/^[A-Za-z0-9_.+-]+$/.test(symbolName)) {
        throw new Error("Unsafe embedded KiCad symbol identifier " + fullName);
      }
      const library = symbolsByLibrary.get(libraryName) ?? new Map<string, string>();
      const externalForm = symbolForm.replace(`(symbol ${JSON.stringify(fullName)}`, `(symbol ${JSON.stringify(symbolName)}`);
      const previous = library.get(symbolName);
      if (previous !== undefined && previous !== externalForm) {
        throw new Error("Conflicting embedded definitions for KiCad symbol " + fullName);
      }
      library.set(symbolName, externalForm);
      symbolsByLibrary.set(libraryName, library);
    }
  }
  if (symbolsByLibrary.size === 0) throw new Error("KiCad schematic has no portable symbol definitions");

  const files = new Map<string, string>();
  const tableEntries: string[] = [];
  for (const libraryName of [...symbolsByLibrary.keys()].sort()) {
    const definitions = [...symbolsByLibrary.get(libraryName)!.entries()].sort(([left], [right]) => left.localeCompare(right));
    files.set(
      libraryName + ".kicad_sym",
      `(kicad_symbol_lib (version 20211014) (generator circuit-json-to-kicad)\n${definitions
        .map(([, definition]) => "\n" + definition)
        .join("\n")}\n)\n`,
    );
    tableEntries.push(
      `  (lib (name ${JSON.stringify(libraryName)}) (type "KiCad") (uri ${JSON.stringify("$" + "{KIPRJMOD}/" + libraryName + ".kicad_sym")}) (options "") (descr "Exported from Circuit JSON"))`,
    );
  }
  return { files, table: `(sym_lib_table (version 7)\n${tableEntries.join("\n")}\n)\n` };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function ensureOutputDoesNotExist(outputDir: string): Promise<void> {
  try {
    await stat(outputDir);
    throw new Error("KiCad export output directory already exists; refusing to overwrite stale or reviewed artifacts");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export async function exportCircuitJsonToKicad({
  circuitJson,
  outputDir,
  projectName,
}: ExportKicadOptions): Promise<ExportKicadResult> {
  validateProjectName(projectName);
  if (typeof outputDir !== "string" || outputDir.trim().length === 0) {
    throw new Error("KiCad export output directory is required");
  }
  const sourcePinGroups = validateCircuitJson(circuitJson);
  const resolvedOutput = path.resolve(outputDir);
  await ensureOutputDoesNotExist(resolvedOutput);

  const schematicFilename = projectName + ".kicad_sch";
  const pcbFilename = projectName + ".kicad_pcb";
  const projectFilename = projectName + ".kicad_pro";
  const converterCircuitJson = circuitJson as ConstructorParameters<typeof CircuitJsonToKicadSchConverter>[0];
  const artifacts = new Map<string, string>();

  let schematicConverter: CircuitJsonToKicadSchConverter;
  try {
    schematicConverter = new CircuitJsonToKicadSchConverter(converterCircuitJson);
    schematicConverter.runUntilFinished();
    const schematicFiles = schematicConverter.getOutputFiles({ schematicFilename });
    if (schematicFiles.length === 0 || schematicFiles[0].filename !== schematicFilename) {
      throw new Error("converter did not return the requested root schematic");
    }
    for (const file of schematicFiles) addArtifact(artifacts, file.filename, file.content);
  } catch (error) {
    throw new Error("Circuit JSON to KiCad schematic conversion failed: " + (error as Error).message, { cause: error });
  }

  try {
    const pcbConverter = new CircuitJsonToKicadPcbConverter(converterCircuitJson, { projectName });
    pcbConverter.runUntilFinished();
    const pcbContent = pcbConverter.getOutputString();
    if (!pcbContent.trimStart().startsWith("(kicad_pcb")) {
      throw new Error("converter did not return a native KiCad PCB document");
    }
    addArtifact(artifacts, pcbFilename, pcbContent);
  } catch (error) {
    throw new Error("Circuit JSON to KiCad PCB conversion failed: " + (error as Error).message, { cause: error });
  }

  try {
    const projectConverter = new CircuitJsonToKicadProConverter(converterCircuitJson, {
      projectName,
      schematicFilename,
      pcbFilename,
      schematicSheetPlan: schematicConverter!.schematicSheetPlan,
    });
    projectConverter.runUntilFinished();
    const projectContent = projectConverter.getOutputString();
    JSON.parse(projectContent);
    addArtifact(artifacts, projectFilename, projectContent);
  } catch (error) {
    throw new Error("Circuit JSON to KiCad project conversion failed: " + (error as Error).message, { cause: error });
  }

  try {
    const libraryConverter = new CircuitJsonToKicadLibraryConverter(converterCircuitJson, {
      libraryName: projectName + "_custom",
    });
    libraryConverter.runUntilFinished();
    const portableLibraries = portableSymbolLibraries(
      schematicConverter!.getOutputFiles({ schematicFilename }).map((file) => file.content),
    );
    for (const [filename, content] of portableLibraries.files) addArtifact(artifacts, filename, content);
    addArtifact(artifacts, "sym-lib-table", portableLibraries.table);
    addArtifact(artifacts, "fp-lib-table", libraryConverter.getFpLibTableString());
    for (const footprint of libraryConverter.getFootprints()) {
      addArtifact(artifacts, "tscircuit.pretty/" + footprint.footprintName + ".kicad_mod", footprint.kicadModString);
    }
  } catch (error) {
    throw new Error("Circuit JSON to KiCad library conversion failed: " + (error as Error).message, { cause: error });
  }

  const converterPackage = JSON.parse(
    await readFile(new URL("../node_modules/circuit-json-to-kicad/package.json", import.meta.url), "utf8"),
  ) as { version?: string };
  if (converterPackage.version !== EXPECTED_CONVERTER_VERSION) {
    throw new Error(
      "KiCad converter version drifted: expected " + EXPECTED_CONVERTER_VERSION + ", got " + converterPackage.version,
    );
  }

  const circuitJsonSha256 = sha256(JSON.stringify(circuitJson));
  const manifest = {
    schema_version: 1,
    generated_at_utc: new Date().toISOString(),
    project_name: projectName,
    converter: { package: CONVERTER_PACKAGE, version: converterPackage.version },
    input: { circuit_json_sha256: circuitJsonSha256 },
    source_pin_net_groups: sourcePinGroups,
    artifacts: Object.fromEntries(
      [...artifacts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([filename, content]) => [
        filename,
        { sha256: sha256(content), bytes: Buffer.byteLength(content) },
      ]),
    ),
  };
  artifacts.set("export-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  const parentDir = path.dirname(resolvedOutput);
  const basename = path.basename(resolvedOutput);
  await mkdir(parentDir, { recursive: true });
  const stagingDir = await mkdtemp(path.join(parentDir, "." + basename + ".staging-"));
  let reservedOutput = false;
  try {
    for (const [filename, content] of artifacts) {
      const stagedFile = path.join(stagingDir, ...filename.split("/"));
      await mkdir(path.dirname(stagedFile), { recursive: true });
      await writeFile(stagedFile, content, { flag: "wx" });
    }
    await mkdir(resolvedOutput, { recursive: false });
    reservedOutput = true;
    for (const filename of artifacts.keys()) {
      const stagedFile = path.join(stagingDir, ...filename.split("/"));
      const outputFile = path.join(resolvedOutput, ...filename.split("/"));
      await mkdir(path.dirname(outputFile), { recursive: true });
      await rename(stagedFile, outputFile);
    }
  } catch (error) {
    if (reservedOutput) await rm(resolvedOutput, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  return {
    outputDir: resolvedOutput,
    files: [...artifacts.keys()].sort(),
    circuitJsonSha256,
    sourcePinNetGroups: sourcePinGroups,
  };
}

export { assertPinNetMembership, parseKicadNetlistPinNetGroups, sourcePinNetGroups } from "./connectivity.js";
