import assert from "node:assert/strict";
import test from "node:test";
import { createPcbDrcArgs, readPcbDrcEvidence } from "../src/native-drc.js";

test("PCB DRC always enables schematic parity", () => {
  assert.deepEqual(createPcbDrcArgs("drc.json", "board.kicad_pcb"), [
    "pcb", "drc", "--schematic-parity", "--format", "json", "--output", "drc.json", "board.kicad_pcb",
  ]);
});

test("PCB DRC evidence combines violations, open connections, and schematic parity", () => {
  const violation = { type: "clearance" };
  const unconnected = { type: "unconnected_item" };
  const parityIssue = { type: "schematic_parity" };
  assert.deepEqual(readPcbDrcEvidence({
    violations: [violation], unconnected_items: [unconnected], schematic_parity: [parityIssue],
  }), {
    violations: [violation],
    unconnectedItems: [unconnected],
    schematicParityIssues: [parityIssue],
    findings: [violation, unconnected, parityIssue],
  });
});

test("PCB DRC evidence rejects missing result sections", () => {
  assert.throws(() => readPcbDrcEvidence({ violations: [], unconnected_items: [] }), /missing.*schematic_parity/);
});
