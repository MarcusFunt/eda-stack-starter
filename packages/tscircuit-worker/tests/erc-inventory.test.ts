import assert from "node:assert/strict";
import { test } from "node:test";

let buildErcFaultInventory: typeof import("../src/erc-inventory.js")["buildErcFaultInventory"] | undefined;
try {
  ({ buildErcFaultInventory } = await import("../src/erc-inventory.js"));
} catch {
  // The first assertion below is the RED condition until the inventory exists.
}

test("ERC inventory classifies every report entry and links native items to the frozen source fixture", () => {
  assert.equal(typeof buildErcFaultInventory, "function", "fault inventory builder must be implemented");

  const inventory = buildErcFaultInventory!({
    fixture: "ldo-sensor-interface",
    project_path: "benchmarks/fixtures/ldo-sensor-interface",
    build_manifest: {
      source_files: [{ path: "src/modules/ldo.tsx", sha256: "a".repeat(64) }],
      circuit_json_sha256: "b".repeat(64),
      source_graph_sha256: "c".repeat(64),
    },
    source_graph: {
      components: [{ reference: "U1" }],
      ports: [
        { component: "U1", pin: "1", name: "IN", net_id: "N001" },
        { component: "U1", pin: "4", name: "NC", net_id: "N006" },
      ],
      nets: [
        { id: "N001", names: ["VIN"], pins: ["U1:1"] },
        { id: "N006", names: [], pins: ["U1:4"] },
      ],
    },
    circuit_json: [
      { type: "schematic_net_label", schematic_net_label_id: "schematic_net_label_0", text: "VIN", source_net_id: "source_net_0" },
    ],
    erc: {
      ignored_checks: [],
      sheets: [{
        violations: [
          { type: "endpoint_off_grid", description: "Symbol U1 Pin 1 [IN, Passive, Line]", items: [{ uuid: "grid-1", pos: { x: 100.5, y: 80.25 }, description: "Symbol U1 Pin 1 [IN, Passive, Line]" }] },
          { type: "unconnected_wire_endpoint", description: "Unconnected wire endpoint", items: [{ uuid: "wire-1", pos: { x: 101, y: 80 }, description: "Vertical Wire, length 3.00 mm" }] },
          { type: "power_pin_not_driven", description: "Input Power pin not driven by any Output Power pins", items: [{ uuid: "power-1", pos: { x: 102, y: 80 }, description: "Symbol #PWRschematic_net_label_0 Pin 1 [1, Power input, Line]" }] },
          { type: "same_local_global_label", description: "Local and global labels have same name", items: [{ uuid: "label-1", pos: { x: 103, y: 80 }, description: "Global Label 'VIN'" }] },
          { type: "single_global_label", description: "Global label only appears once in the schematic", items: [{ uuid: "single-label-1", pos: { x: 103, y: 81 }, description: "Global Label 'VIN'" }] },
          { type: "footprint_filter", description: "Assigned footprint () does not match footprint filters (SOT-23-5)", items: [{ uuid: "filter-1", pos: { x: 104, y: 80 }, description: "Symbol U1 [chip]" }] },
          { type: "pin_not_connected", description: "Pin not connected", items: [{ uuid: "nc-1", pos: { x: 104, y: 80 }, description: "Symbol U1 Pin 4 [NC, Passive, Line]" }] },
        ],
      }],
    },
  });

  assert.equal(inventory.finding_count, 7);
  assert.deepEqual(inventory.category_counts, {
    exporter_defect: 1,
    hierarchy_label_issue: 2,
    power_source_semantics: 1,
    symbol_pin_type_error: 1,
    unconnected_endpoint_grid_geometry: 2,
  });
  assert.deepEqual(inventory.erc_ignored_checks, []);
  assert.deepEqual(inventory.findings.map((finding) => finding.category), [
    "unconnected_endpoint_grid_geometry",
    "unconnected_endpoint_grid_geometry",
    "power_source_semantics",
    "hierarchy_label_issue",
    "hierarchy_label_issue",
    "exporter_defect",
    "symbol_pin_type_error",
  ]);
  assert.equal(inventory.findings[0].source_reference.native_items[0].uuid, "grid-1");
  assert.equal(inventory.findings[0].source_reference.source_files[0].path, "benchmarks/fixtures/ldo-sensor-interface/src/modules/ldo.tsx");
  assert.equal(inventory.findings[2].source_reference.source_nets[0].id, "N001");
  assert.ok(inventory.findings.every((finding) => finding.likely_root_cause.length > 20));
  assert.equal(inventory.findings[6].source_reference.source_pins[0].pin_name, "NC");
  assert.equal(inventory.findings[6].source_reference.source_pins[0].net_id, "N006");
});

test("ERC inventory rejects unknown native violation types rather than hiding them", () => {
  assert.equal(typeof buildErcFaultInventory, "function", "fault inventory builder must be implemented");
  assert.throws(() => buildErcFaultInventory!({
    fixture: "voltage-divider",
    project_path: "benchmarks/fixtures/voltage-divider",
    build_manifest: { source_files: [], circuit_json_sha256: "b".repeat(64), source_graph_sha256: "c".repeat(64) },
    source_graph: { components: [], ports: [], nets: [] },
    circuit_json: [],
    erc: { ignored_checks: [], sheets: [{ violations: [{ type: "new_kicad_check", description: "unmapped", items: [] }] }] },
  }), /unclassified KiCad ERC finding type/);
});

test("ERC inventory treats an unconnected required pin as an electrical defect", () => {
  assert.equal(typeof buildErcFaultInventory, "function", "fault inventory builder must be implemented");
  const inventory = buildErcFaultInventory!({
    fixture: "ldo-sensor-interface",
    project_path: "benchmarks/fixtures/ldo-sensor-interface",
    build_manifest: { source_files: [], circuit_json_sha256: "b".repeat(64), source_graph_sha256: "c".repeat(64) },
    source_graph: { components: [{ reference: "U1" }], ports: [], nets: [] },
    circuit_json: [],
    erc: { ignored_checks: [], sheets: [{ violations: [{
      type: "pin_not_connected",
      description: "Pin not connected",
      items: [{ uuid: "required-1", pos: { x: 1, y: 2 }, description: "Symbol U1 Pin 1 [IN, Passive, Line]" }],
    }] }] },
  });
  assert.equal(inventory.findings[0].category, "actual_electrical_defect");
});

test("ERC inventory records KiCad CLI custom footprint table failures as exporter compatibility defects", () => {
  const inventory = buildErcFaultInventory!({
    fixture: "voltage-divider",
    project_path: "benchmarks/fixtures/voltage-divider",
    build_manifest: { source_files: [], circuit_json_sha256: "b".repeat(64), source_graph_sha256: "c".repeat(64) },
    source_graph: { components: [], ports: [], nets: [] },
    circuit_json: [],
    erc: {
      ignored_checks: [],
      sheets: [{ violations: [{
        type: "footprint_link_issues",
        description: "The current configuration does not include the footprint library 'tscircuit'",
        items: [{ uuid: "fp-link-1", pos: { x: 1, y: 2 }, description: "Symbol R1 [1kΩ]" }],
      }] }],
    },
  });
  assert.equal(inventory.findings[0].category, "exporter_defect");
  assert.equal(inventory.findings[0].root_cause_confidence, "established");
  assert.match(inventory.findings[0].likely_root_cause, /KiCad 10\.0\.8 CLI/);
});
