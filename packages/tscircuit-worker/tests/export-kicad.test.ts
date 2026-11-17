import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseKicadSch, Xy } from "kicadts";

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

const NATIVE_SCHEMATIC_GRID_MM = 1.27;

function isOnNativeSchematicGrid(value: number): boolean {
  const gridSteps = value / NATIVE_SCHEMATIC_GRID_MM;
  return Math.abs(gridSteps - Math.round(gridSteps)) <= 1e-6;
}

function rotateSchematicPoint(point: { x: number; y: number }, angle: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180;
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
  };
}

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

test("native schematic electrical anchors use the KiCad 50 mil grid", { skip: !exporter }, async () => {
  const circuitJson = JSON.parse(
    await readFile(new URL("../fixtures/power-rail.circuit.json", import.meta.url), "utf8"),
  ) as unknown[];
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "edastack-kicad-grid-"));
  const outputDir = path.join(tempRoot, "power-rail");
  try {
    await exporter!.exportCircuitJsonToKicad({ circuitJson, outputDir, projectName: "power-rail" });
    const schematic = parseKicadSch(await readFile(path.join(outputDir, "power-rail.kicad_sch"), "utf8"));
    const definitions = new Map((schematic.libSymbols?.symbols ?? []).map((symbol) => [symbol.libraryId, symbol]));

    for (const symbol of schematic.symbols) {
      const reference = symbol.properties.find((property) => property.key === "Reference")?.value ?? symbol.libraryId;
      assert.ok(symbol.at, `${reference} must have a position`);
      const at = symbol.at;
      const angle = (((at.angle ?? 0) % 360) + 360) % 360;
      assert.ok([0, 90, 180, 270].includes(angle), `${reference} must use a cardinal rotation`);
      assert.ok(isOnNativeSchematicGrid(at.x), `${reference} origin X must be on the 50 mil grid`);
      assert.ok(isOnNativeSchematicGrid(at.y), `${reference} origin Y must be on the 50 mil grid`);

      const definition = definitions.get(symbol.libraryId);
      assert.ok(definition, `${reference} must have an embedded symbol definition`);
      for (const unit of definition.subSymbols) {
        for (const pin of unit.pins ?? []) {
          assert.ok(pin.at, `${reference} pin ${pin.numberString} must have a position`);
          const rotated = rotateSchematicPoint({ x: pin.at.x, y: pin.at.y }, angle);
          const pinX = at.x + rotated.x;
          const pinY = at.y - rotated.y;
          assert.ok(isOnNativeSchematicGrid(pinX), `${reference} pin ${pin.numberString} X must be on the 50 mil grid`);
          assert.ok(isOnNativeSchematicGrid(pinY), `${reference} pin ${pin.numberString} Y must be on the 50 mil grid`);
        }
      }
    }

    for (const wire of schematic.wires ?? []) {
      for (const point of wire.points?.points ?? []) {
        assert.ok(point instanceof Xy, "schematic wires must use straight XY points");
        assert.ok(isOnNativeSchematicGrid(point.x), `wire endpoint X=${point.x} must be on the 50 mil grid`);
        assert.ok(isOnNativeSchematicGrid(point.y), `wire endpoint Y=${point.y} must be on the 50 mil grid`);
      }
    }
    for (const label of [...(schematic.labels ?? []), ...(schematic.globalLabels ?? [])]) {
      assert.ok(label.at, `label ${label.value} must have a position`);
      const at = label.at;
      assert.ok(isOnNativeSchematicGrid(at.x), `label ${label.value} X must be on the 50 mil grid`);
      assert.ok(isOnNativeSchematicGrid(at.y), `label ${label.value} Y must be on the 50 mil grid`);
    }
    for (const marker of [...(schematic.junctions ?? []), ...(schematic.noConnects ?? [])]) {
      if (!marker.at) continue;
      assert.ok(isOnNativeSchematicGrid(marker.at.x), "junction/no-connect X must be on the 50 mil grid");
      assert.ok(isOnNativeSchematicGrid(marker.at.y), "junction/no-connect Y must be on the 50 mil grid");
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("native grid normalization preserves junction and no-connect marker syntax", { skip: !exporter }, async () => {
  const circuitJson = JSON.parse(
    await readFile(
      new URL("../../../benchmarks/native-erc-inventory/2026-11-09/fixtures/ldo-sensor-interface/project-build/circuit.json", import.meta.url),
      "utf8",
    ),
  ) as unknown[];
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "edastack-kicad-marker-syntax-"));
  const outputDir = path.join(tempRoot, "ldo-sensor-interface");
  try {
    await exporter!.exportCircuitJsonToKicad({ circuitJson, outputDir, projectName: "ldo-sensor-interface" });
    const schematic = parseKicadSch(
      await readFile(path.join(outputDir, "power.kicad_sch"), "utf8"),
    );
    assert.ok(schematic.junctions.length > 0, "fixture must include native junctions");
    assert.ok(schematic.noConnects.length > 0, "fixture must include native no-connect markers");
    for (const marker of [...schematic.junctions, ...schematic.noConnects]) {
      assert.equal(marker.at?.angle, undefined, "junction and no-connect markers must not gain an angle field");
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("native KiCad project enables ERC checks that KiCad defaults to ignoring", { skip: !exporter }, async () => {
  const circuitJson = JSON.parse(
    await readFile(new URL("../fixtures/power-rail.circuit.json", import.meta.url), "utf8"),
  ) as unknown[];
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "edastack-kicad-erc-severity-"));
  const outputDir = path.join(tempRoot, "power-rail");
  try {
    await exporter!.exportCircuitJsonToKicad({ circuitJson, outputDir, projectName: "power-rail" });
    const project = JSON.parse(await readFile(path.join(outputDir, "power-rail.kicad_pro"), "utf8"));
    for (const check of ["footprint_filter", "four_way_junction", "simulation_model_issue", "single_global_label"]) {
      assert.equal(project.erc.rule_severities?.[check], "warning", `${check} must be reported, not ignored`);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("single-sheet native schematics export non-power labels with local scope", { skip: !exporter }, async () => {
  const circuitJson = JSON.parse(
    await readFile(new URL("../fixtures/power-rail.circuit.json", import.meta.url), "utf8"),
  ) as Array<Record<string, unknown>>;
  circuitJson.push({
    type: "schematic_net_label",
    schematic_net_label_id: "test_local_label",
    text: "LOCAL_ONLY",
    source_net_id: "source_net_0",
    anchor_position: { x: 10, y: 10 },
    center: { x: 10, y: 10 },
    anchor_side: "left",
  });
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "edastack-kicad-local-labels-"));
  const outputDir = path.join(tempRoot, "power-rail");
  try {
    await exporter!.exportCircuitJsonToKicad({ circuitJson, outputDir, projectName: "power-rail" });
    const schematic = await readFile(path.join(outputDir, "power-rail.kicad_sch"), "utf8");
    assert.match(schematic, /\(label "LOCAL_ONLY"/);
    assert.doesNotMatch(schematic, /\(global_label "LOCAL_ONLY"/);
    assert.match(schematic, /\(lib_id "Custom:rail_up"/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("native symbols carry the exact generated footprint and accept it in their library filter", { skip: !exporter }, async () => {
  const circuitJson = JSON.parse(
    await readFile(new URL("../fixtures/two-resistor-labels.circuit.json", import.meta.url), "utf8"),
  ) as unknown[];
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "edastack-kicad-symbol-footprints-"));
  const outputDir = path.join(tempRoot, "two-resistor-labels");
  try {
    await exporter!.exportCircuitJsonToKicad({ circuitJson, outputDir, projectName: "two-resistor-labels" });
    const schematic = await readFile(path.join(outputDir, "two-resistor-labels.kicad_sch"), "utf8");
    const symbols = await readFile(path.join(outputDir, "Device.kicad_sym"), "utf8");
    const r1Symbol = /\(symbol\s+\(lib_id\s+"Device:boxresistor_right"\)[\s\S]*?\(property "Reference" "R1"[\s\S]*?\(property "Footprint" "([^"]*)"/.exec(schematic);
    assert.equal(r1Symbol?.[1], "tscircuit:resistor_res0402");
    assert.match(symbols, /\(property "ki_fp_filters" "[^\"]*resistor_res0402/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("native footprint binding uses the converter's sanitized name for parameterized footprints", { skip: !exporter }, async () => {
  const circuitJson = JSON.parse(
    await readFile(new URL("../fixtures/two-resistor-labels.circuit.json", import.meta.url), "utf8"),
  ) as Array<Record<string, unknown>>;
  const r1 = circuitJson.find((item) => item.type === "source_component" && item.name === "R1");
  assert.ok(r1 && typeof r1.source_component_id === "string");
  const r1Cad = circuitJson.find((item) => item.type === "cad_component" && item.source_component_id === r1.source_component_id);
  assert.ok(r1Cad);
  r1Cad.footprinter_string = "0603_color(red)";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "edastack-kicad-sanitized-footprint-"));
  const outputDir = path.join(tempRoot, "two-resistor-labels");
  try {
    await exporter!.exportCircuitJsonToKicad({ circuitJson, outputDir, projectName: "two-resistor-labels" });
    const schematic = await readFile(path.join(outputDir, "two-resistor-labels.kicad_sch"), "utf8");
    assert.match(schematic, /\(property "Footprint" "tscircuit:resistor_0603_color_red"/);
    assert.ok(await stat(path.join(outputDir, "tscircuit.pretty", "resistor_0603_color_red.kicad_mod")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
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
