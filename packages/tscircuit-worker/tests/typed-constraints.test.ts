import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");

async function fixtureInput(rules: unknown[] = []) {
  const fixtureRoot = path.join(repositoryRoot, "benchmarks", "fixtures", "led-transistor");
  const evidenceRoot = path.join(repositoryRoot, "benchmarks", "native-erc-inventory", "2026-11-09", "fixtures", "led-transistor");
  const sourcePaths = [
    "src/board.tsx",
    "src/modules/low-side-led.tsx",
  ];
  const sourceFiles = await Promise.all(sourcePaths.map(async (relativePath) => ({
    path: relativePath,
    text: await readFile(path.join(fixtureRoot, ...relativePath.split("/")), "utf8"),
  })));
  const constraintsPath = path.join(fixtureRoot, "pcb.constraints.json");
  const constraintsText = await readFile(constraintsPath, "utf8");
  sourceFiles.push({ path: "pcb.constraints.json", text: constraintsText });

  return {
    circuitJson: JSON.parse(await readFile(path.join(evidenceRoot, "project-build", "circuit.json"), "utf8")) as unknown[],
    pcbConstraints: JSON.parse(constraintsText) as unknown,
    sourceFiles,
    rules,
  };
}

async function loadCompiler() {
  const modulePath = "../src/typed-constraints.js";
  try {
    return await import(modulePath) as {
      buildTypedCircuitIR: (input: Awaited<ReturnType<typeof fixtureInput>>) => {
        ir: {
          components: Array<{ reference: string; source: { path: string; line: number; column: number } }>;
          pins: Array<{ reference: string; number: number; sourcePortId: string; physicalPads: Array<{ pcbPortId: string; pcbComponentId: string | null; sourceComponentId: string | null }> }>;
          nets: Array<{ name: string; pinIds: string[] }>;
          electricalRules: Array<{ id: string; target: { type: string } }>;
          physicalConstraints: Array<{ id: string; property: string; value: number }>;
          componentConstraints: Array<{ id: string; property: string; target: { reference: string } }>;
        };
        diagnostics: Array<{ id: string; code: string; source: { path: string; line: number; column: number } }>;
      };
    };
  } catch {
    assert.fail("typed constraint compiler is not implemented yet");
  }
}

test("typed IR keeps source, circuit-pin, and physical-pad identities", async () => {
  const { buildTypedCircuitIR } = await loadCompiler();
  const input = await fixtureInput();
  const result = buildTypedCircuitIR(input);
  const secondResult = buildTypedCircuitIR(input);
  const golden = JSON.parse(await readFile(path.join(packageRoot, "fixtures", "typed-constraints", "led-transistor.ir.json"), "utf8"));

  assert.deepEqual(result, secondResult, "typed circuit output is deterministic");
  assert.deepEqual(result, golden, "typed circuit output matches the checked-in golden fixture");
  assert.deepEqual(result.ir.components.map((component) => component.reference), ["D1", "J1", "Q1", "R1", "R2"]);
  assert.equal(result.ir.components.find((component) => component.reference === "D1")?.source.path, "src/modules/low-side-led.tsx");
  assert.equal(result.ir.components.find((component) => component.reference === "D1")?.source.line, 5);
  assert.equal(result.ir.pins.length, 12);

  const connectorPin = result.ir.pins.find((pin) => pin.reference === "J1" && pin.number === 1);
  assert.equal(connectorPin?.sourcePortId, "source_port_0");
  assert.deepEqual(connectorPin?.physicalPads.map((pad) => [pad.pcbPortId, pad.pcbComponentId, pad.sourceComponentId]), [["pcb_port_0", "pcb_component_0", "source_component_0"]]);

  const transistorPin = result.ir.pins.find((pin) => pin.reference === "Q1" && pin.number === 1);
  assert.equal(transistorPin?.sourcePortId, "source_port_3");
  assert.deepEqual(transistorPin?.physicalPads, [], "missing physical pads remain explicit rather than dropping source pins");

  assert.deepEqual(result.ir.nets.map((net) => net.name).sort(), ["", "", "", "CTRL", "GND", "VCC"]);
  assert.equal(result.ir.nets.reduce((total, net) => total + net.pinIds.length, 0), 12);
  assert.ok(result.ir.electricalRules.some((rule) => rule.id === "electrical:pin:source_port_0:provides_power"));
  assert.ok(result.ir.electricalRules.some((rule) => rule.target.type === "net"));
  assert.deepEqual(result.ir.physicalConstraints.map(({ property, value }) => [property, value]), [
    ["height_mm", 18],
    ["layers", 2],
    ["width_mm", 30],
  ]);
  assert.deepEqual(result.ir.componentConstraints.map(({ target, property }) => [target.reference, property]), [["J1", "fixed"]]);
  assert.deepEqual(result.diagnostics.map(({ code }) => code), [
    "PIN_PHYSICAL_PAD_MISSING",
    "PIN_PHYSICAL_PAD_MISSING",
    "PIN_PHYSICAL_PAD_MISSING",
  ]);
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.source.path === "src/modules/low-side-led.tsx"));
});

test("typed constraint validation reports duplicate, unsupported, missing, and infeasible rules", async () => {
  const { buildTypedCircuitIR } = await loadCompiler();
  const rules = [
    { id: "board-width-min", kind: "physical", target: { type: "board" }, property: "width_mm", operator: ">=", value: 30, hard: true, source: { path: "pcb.constraints.json", jsonPointer: "/board/width_mm" } },
    { id: "board-width-min", kind: "physical", target: { type: "board" }, property: "width_mm", operator: ">=", value: 31, hard: true, source: { path: "pcb.constraints.json", jsonPointer: "/board/width_mm" } },
    { id: "duplicate-width-min", kind: "physical", target: { type: "board" }, property: "width_mm", operator: ">=", value: 30, hard: true, source: { path: "pcb.constraints.json", jsonPointer: "/board/width_mm" } },
    { id: "missing-sensor-pin", kind: "electrical", target: { type: "pin", reference: "J1", pin_number: 99 }, property: "net", operator: "==", value: "VCC", hard: true, source: { path: "pcb.constraints.json", jsonPointer: "/rules/2" } },
    { id: "bad-operator", kind: "component", target: { type: "component", reference: "J1" }, property: "position_x_mm", operator: "approximately", value: 1, hard: true, source: { path: "pcb.constraints.json", jsonPointer: "/rules/3" } },
  ];
  const result = buildTypedCircuitIR(await fixtureInput(rules));

  assert.deepEqual(result.diagnostics.map(({ code, id }) => [code, id]), [
    ["DUPLICATE_CONSTRAINT", "duplicate-width-min"],
    ["DUPLICATE_CONSTRAINT_ID", "board-width-min"],
    ["INFEASIBLE_HARD_CONSTRAINTS", "infeasible:board:width_mm"],
    ["MISSING_PIN_REFERENCE", "missing-sensor-pin"],
    ["PIN_PHYSICAL_PAD_MISSING", "physical-pad:source_port_3"],
    ["PIN_PHYSICAL_PAD_MISSING", "physical-pad:source_port_4"],
    ["PIN_PHYSICAL_PAD_MISSING", "physical-pad:source_port_5"],
    ["UNSUPPORTED_OPERATOR", "bad-operator"],
  ]);
  assert.deepEqual(result.diagnostics.map(({ source }) => [source.path, source.line, source.column]), [
    ["pcb.constraints.json", 3, 14],
    ["pcb.constraints.json", 3, 14],
    ["pcb.constraints.json", 3, 14],
    ["pcb.constraints.json", 1, 1],
    ["src/modules/low-side-led.tsx", 4, 7],
    ["src/modules/low-side-led.tsx", 4, 7],
    ["src/modules/low-side-led.tsx", 4, 7],
    ["pcb.constraints.json", 1, 1],
  ]);
  assert.ok(result.ir.physicalConstraints.some((constraint) => constraint.id === "board-width-min"));
  assert.ok(result.ir.electricalRules.some((constraint) => constraint.id === "missing-sensor-pin"));
  assert.ok(result.ir.componentConstraints.some((constraint) => constraint.id === "bad-operator"));
});

test("an empty allowed-value set is an infeasible hard constraint", async () => {
  const { buildTypedCircuitIR } = await loadCompiler();
  const result = buildTypedCircuitIR(await fixtureInput([
    { id: "no-legal-position", kind: "component", target: { type: "component", reference: "J1" }, property: "position_x_mm", operator: "in", value: [], hard: true },
  ]));

  assert.ok(result.diagnostics.some((diagnostic) =>
    diagnostic.code === "INFEASIBLE_HARD_CONSTRAINTS" && diagnostic.id === "infeasible:J1:position_x_mm",
  ));
});

test("typed constraint JSON schema accepts valid rules and rejects missing pin identity", async () => {
  const schema = JSON.parse(await readFile(path.join(repositoryRoot, "schemas", "typed-circuit-constraints.schema.json"), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const valid = {
    schema_version: 1,
    rules: [{ id: "sensor-input", kind: "electrical", target: { type: "pin", reference: "J1", pin_number: 1 }, property: "net", operator: "==", value: "VCC" }],
  };
  const invalid = {
    schema_version: 1,
    rules: [{ id: "sensor-input", kind: "electrical", target: { type: "pin", reference: "J1" }, property: "net", operator: "==", value: "VCC" }],
  };

  assert.equal(validate(valid), true);
  assert.equal(validate(invalid), false);
});
