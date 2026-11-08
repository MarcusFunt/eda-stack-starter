import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

type ExporterModule = typeof import("../src/export-kicad.js");
let exporter: ExporterModule | undefined;
try {
  exporter = await import("../src/export-kicad.js");
} catch {
  // Keep the missing adapter as an assertion failure for the RED step.
}

const fixtures = [
  { name: "rc", expectedGroups: 3 },
  { name: "two-resistor-labels", expectedGroups: 3 },
  { name: "power-rail", expectedGroups: 2 },
];

function formEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index + 1;
  }
  throw new Error("unbalanced test S-expression");
}

function childForms(form: string): string[] {
  const end = formEnd(form, 0);
  let cursor = 1;
  while (cursor < end - 1 && !/\s/.test(form[cursor] ?? "")) cursor += 1;
  const children: string[] = [];
  while (cursor < end - 1) {
    while (/\s/.test(form[cursor] ?? "")) cursor += 1;
    if (cursor >= end - 1) break;
    if (form[cursor] !== "(") throw new Error("unexpected test S-expression atom");
    const next = formEnd(form, cursor);
    children.push(form.slice(cursor, next));
    cursor = next;
  }
  return children;
}

function symbolDefinitions(text: string, library: string): Map<string, string> {
  const start = text.indexOf("(lib_symbols");
  assert.notEqual(start, -1);
  const section = text.slice(start, formEnd(text, start));
  const definitions = new Map<string, string>();
  for (const form of childForms(section).filter((item) => item.startsWith("(symbol "))) {
    const match = form.match(/^\(symbol\s+("(?:\\.|[^"\\])*")/);
    assert.ok(match);
    const fullName = JSON.parse(match[1]) as string;
    if (!fullName.startsWith(library + ":")) continue;
    const symbolName = fullName.slice(library.length + 1);
    definitions.set(symbolName, form.replace(`(symbol ${JSON.stringify(fullName)}`, `(symbol ${JSON.stringify(symbolName)}`));
  }
  return definitions;
}

function externalSymbolDefinitions(text: string): Map<string, string> {
  return new Map(
    childForms(text)
      .filter((item) => item.startsWith("(symbol "))
      .map((form) => {
        const match = form.match(/^\(symbol\s+("(?:\\.|[^"\\])*")/);
        assert.ok(match);
        return [JSON.parse(match[1]) as string, form];
      }),
  );
}

test("native KiCad adapter is implemented", () => {
  assert.equal(typeof exporter?.exportCircuitJsonToKicad, "function");
});

test("Circuit JSON exports schematic, PCB, project, and a provenance manifest", { skip: !exporter }, async () => {
  for (const fixture of fixtures) {
    const circuitJson = JSON.parse(
      await readFile(new URL(`../fixtures/${fixture.name}.circuit.json`, import.meta.url), "utf8"),
    ) as unknown[];
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "edastack-kicad-export-"));
    const outputDir = path.join(tempRoot, fixture.name);
    try {
      const result = await exporter!.exportCircuitJsonToKicad({
        circuitJson,
        outputDir,
        projectName: fixture.name,
      });
      assert.deepEqual(result.sourcePinNetGroups.length, fixture.expectedGroups, fixture.name);
      for (const name of [
        `${fixture.name}.kicad_sch`,
        `${fixture.name}.kicad_pcb`,
        `${fixture.name}.kicad_pro`,
        "Device.kicad_sym",
        "Custom.kicad_sym",
        "sym-lib-table",
        "fp-lib-table",
        "export-manifest.json",
      ]) {
        const info = await stat(path.join(outputDir, name));
        assert.ok(info.isFile() && info.size > 0, `${fixture.name} must write ${name}`);
      }
      const footprintDir = path.join(outputDir, "tscircuit.pretty");
      assert.ok((await stat(footprintDir)).isDirectory(), `${fixture.name} must include its project footprints`);
      const symbolTable = await readFile(path.join(outputDir, "sym-lib-table"), "utf8");
      const schematic = await readFile(path.join(outputDir, `${fixture.name}.kicad_sch`), "utf8");
      const symbolRefs = [
        ...schematic.matchAll(/\(lib_id\s+"([^":]+):([^"\\]+)"\)/g),
      ].map((match) => ({ library: match[1], symbol: match[2] }));
      assert.ok(symbolRefs.length > 0, `${fixture.name} schematic must reference library symbols`);
      for (const libraryName of [...new Set(symbolRefs.map((reference) => reference.library))]) {
        assert.match(
          symbolTable,
          new RegExp(`\\(lib \\(name "${libraryName}"\\)[^\\n]*\\$\\{KIPRJMOD\\}/${libraryName}\\.kicad_sym`),
          `${fixture.name} must resolve converter symbols under ${libraryName}`,
        );
      }
      for (const { library, symbol } of symbolRefs) {
        const symbolLibrary = await readFile(path.join(outputDir, `${library}.kicad_sym`), "utf8");
        const embeddedDefinitions = symbolDefinitions(schematic, library);
        const externalDefinitions = externalSymbolDefinitions(symbolLibrary);
        assert.equal(externalDefinitions.get(symbol), embeddedDefinitions.get(symbol), `${fixture.name} ${library}:${symbol} external definition must match exactly`);
      }
      const manifest = JSON.parse(await readFile(path.join(outputDir, "export-manifest.json"), "utf8"));
      assert.equal(manifest.converter.package, "circuit-json-to-kicad");
      assert.equal(manifest.converter.version, "0.0.270");
      assert.equal(manifest.input.circuit_json_sha256, result.circuitJsonSha256);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});

test("converter refuses a colliding package pad before creating artifacts", { skip: !exporter }, async () => {
  const circuitJson = JSON.parse(
    await readFile(new URL("../fixtures/two-resistor-labels.circuit.json", import.meta.url), "utf8"),
  ) as Array<Record<string, unknown>>;
  const port = circuitJson.find((item) => item.type === "source_port");
  assert.ok(port);
  const duplicate = { ...port, source_port_id: "colliding-port", pin_number: 1 };
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "edastack-kicad-collision-"));
  const outputDir = path.join(tempRoot, "should-not-exist");
  try {
    await assert.rejects(
      exporter!.exportCircuitJsonToKicad({
        circuitJson: [...circuitJson, duplicate],
        outputDir,
        projectName: "collision",
      }),
      /duplicate.*pin|pad.*collision/i,
    );
    await assert.rejects(stat(outputDir), { code: "ENOENT" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("converter rejects invalid project names before writing output", { skip: !exporter }, async () => {
  const circuitJson = JSON.parse(
    await readFile(new URL("../fixtures/two-resistor-labels.circuit.json", import.meta.url), "utf8"),
  ) as unknown[];
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "edastack-kicad-project-name-"));
  try {
    await assert.rejects(
      exporter!.exportCircuitJsonToKicad({
        circuitJson,
        outputDir: path.join(tempRoot, "bad"),
        projectName: "../outside",
      }),
      /project name/i,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("converter refuses to replace an existing export directory", { skip: !exporter }, async () => {
  const circuitJson = JSON.parse(
    await readFile(new URL("../fixtures/two-resistor-labels.circuit.json", import.meta.url), "utf8"),
  ) as unknown[];
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "edastack-kicad-stale-output-"));
  const outputDir = path.join(tempRoot, "reviewed-export");
  await mkdir(outputDir);
  await writeFile(path.join(outputDir, "keep.txt"), "reviewed artifact\n");
  try {
    await assert.rejects(
      exporter!.exportCircuitJsonToKicad({ circuitJson, outputDir, projectName: "stale-check" }),
      /output directory already exists/i,
    );
    assert.equal(await readFile(path.join(outputDir, "keep.txt"), "utf8"), "reviewed artifact\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
