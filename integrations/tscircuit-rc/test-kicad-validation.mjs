import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as workspacePaths from "./workspace-path.mjs";
import { rcSourceManifestGraph } from "./rc-source-fixture.mjs";
const { workspaceRelativePath } = workspacePaths;

const validation = await import("./kicad-consistency.mjs").catch(() => ({}));

function assertValidationModuleAvailable() {
  assert.equal(typeof validation.parseKicadNetlist, "function");
  assert.equal(typeof validation.assertCircuitMapping, "function");
  assert.equal(typeof validation.assertRcSourceMapping, "function");
}

const source = () => ({
  design: { parameters: { resistance: "1k", capacitance: "100n" } },
  sourceManifest: {
    ...rcSourceManifestGraph(),
    source_values: { resistance: "1k", capacitance: "100n" },
    spice_components: [
      { name: "R1", nodes: ["N1", "N2"], statement: "RR1 N1 N2 1K" },
      { name: "C1", nodes: ["N2", "0"], statement: "CC1 N2 0 100N" },
      {
        name: "simulation_voltage_source_0",
        nodes: ["N1", "0"],
        statement: "Vsimulation_voltage_source_0 N1 0 PULSE(0 5 0 1n 1n 1m 2m)",
      },
    ],
  },
  bom: {
    requirements: {
      R1: { resistance_ohm: 1000, tolerance_pct_max: 1, package: "0603 / EIA 1608" },
      C1: { capacitance_F: 1e-7, tolerance_pct_max_at_25C: 10, package: "0603 / EIA 1608" },
    },
    items: [
      {
        reference: "R1",
        manufacturer_verified_properties: {
          resistance_ohm: 1000,
          tolerance_pct: 1,
          package: "0603 / 1608 metric",
        },
        footprint_and_pin_map: {
          footprint: "Resistor_SMD:R_0603_1608Metric",
        },
      },
      {
        reference: "C1",
        manufacturer_verified_properties: {
          capacitance_F: 1e-7,
          tolerance_pct: 10,
          package: "0603 / 1608 metric",
        },
        footprint_and_pin_map: {
          footprint: "Capacitor_SMD:C_0603_1608Metric",
        },
      },
    ],
  },
});

const netlist = (r1Value = "1k", inputNet = "/in") => `(export
  (components
    (comp (ref "R1") (value "${r1Value}") (footprint "Resistor_SMD:R_0603_1608Metric"))
    (comp (ref "C1") (value "100n") (footprint "Capacitor_SMD:C_0603_1608Metric"))
    (comp (ref "TP1") (value "TP1") (footprint "TestPoint:TestPoint_Pad_D1.5mm"))
    (comp (ref "TP2") (value "TP2") (footprint "TestPoint:TestPoint_Pad_D1.5mm"))
    (comp (ref "TP3") (value "TP3") (footprint "TestPoint:TestPoint_Pad_D1.5mm"))
  )
  (nets
    (net (name "${inputNet}") (node (ref "R1") (pin "1")) (node (ref "TP1") (pin "1")))
    (net (name "/out") (node (ref "R1") (pin "2")) (node (ref "C1") (pin "1")) (node (ref "TP2") (pin "1")))
    (net (name "GND") (node (ref "C1") (pin "2")) (node (ref "TP3") (pin "1")))
  )
)`;

test("parses KiCad component values, footprints, and node connectivity", () => {
  assertValidationModuleAvailable();
  const parsed = validation.parseKicadNetlist(netlist());
  assert.equal(parsed.components.R1.value, "1k");
  assert.equal(parsed.components.R1.footprint, "Resistor_SMD:R_0603_1608Metric");
  assert.deepEqual(parsed.nets["/in"], ["R1:1", "TP1:1"]);
});

test("rejects a KiCad resistor value that drifts from the SPICE source", () => {
  assertValidationModuleAvailable();
  const input = source();
  assert.throws(
    () => validation.assertCircuitMapping({ ...input, kicad: validation.parseKicadNetlist(netlist("3k")) }),
    /R1.*value|value.*R1/i,
  );
});

test("accepts scientific-notation values when the source, BOM, and KiCad agree", () => {
  assertValidationModuleAvailable();
  const input = source();
  input.design.parameters.resistance = "1e3";
  input.sourceManifest.source_values.resistance = "1e3";
  input.sourceManifest.spice_components[0].statement = "RR1 N1 N2 1e3";
  assert.doesNotThrow(() =>
    validation.assertCircuitMapping({ ...input, kicad: validation.parseKicadNetlist(netlist("1e3")) }),
  );
});

test("accepts tscircuit-normalized SPICE values that are numerically equivalent to the design", () => {
  assertValidationModuleAvailable();
  const input = source();
  input.design.parameters.resistance = "1000";
  input.sourceManifest.source_values.resistance = "1000";
  input.sourceManifest.spice_components[0].statement = "RR1 N1 N2 1K";
  assert.doesNotThrow(() =>
    validation.assertCircuitMapping({ ...input, kicad: validation.parseKicadNetlist(netlist("1k")) }),
  );
});

test("rejects a source component that the SPICE converter omitted", () => {
  assertValidationModuleAvailable();
  const input = source();
  input.sourceManifest.source_components.push({
    source_component_id: "component_u1",
    name: "U1",
    ftype: "simple_chip",
  });
  assert.throws(
    () => validation.assertRcSourceMapping(input),
    /source component set|source component type/i,
  );
});

test("rejects a named-net pin connection that differs from the fixed RC source", () => {
  assertValidationModuleAvailable();
  const input = source();
  input.sourceManifest.source_traces.find((trace) => trace.source_trace_id === "trace_r1_in").connected_source_net_ids = ["net_out"];
  assert.throws(
    () => validation.assertRcSourceMapping(input),
    /named net|source topology/i,
  );
});

test("rejects a source trace that references an unknown identity even when it has no connections", () => {
  assertValidationModuleAvailable();
  const input = source();
  input.sourceManifest.source_traces.push({
    source_trace_id: "trace_unknown",
    connected_source_port_ids: ["unknown_port_id"],
    connected_source_net_ids: [],
  });
  assert.throws(() => validation.assertRcSourceMapping(input), /unknown port\/net identity/);
});

test("rejects an extra SPICE component even if the expected RC pins remain connected", () => {
  assertValidationModuleAvailable();
  const input = source();
  input.sourceManifest.spice_components.push({
    name: "R2",
    nodes: ["N3", "0"],
    statement: "RR2 N3 0 1K",
  });
  assert.throws(
    () => validation.assertCircuitMapping({ ...input, kicad: validation.parseKicadNetlist(netlist()) }),
    /component set|components/i,
  );
});

test("rejects a collapsed input and output node in the SPICE source", () => {
  assertValidationModuleAvailable();
  const input = source();
  input.sourceManifest.spice_components[0].nodes = ["N1", "N1"];
  input.sourceManifest.spice_components[1].nodes = ["N1", "0"];
  assert.throws(
    () => validation.assertCircuitMapping({ ...input, kicad: validation.parseKicadNetlist(netlist()) }),
    /distinct|topology|node/i,
  );
});

test("rejects KiCad netlist connectivity drift", () => {
  assertValidationModuleAvailable();
  const input = source();
  assert.throws(
    () => validation.assertCircuitMapping({ ...input, kicad: validation.parseKicadNetlist(netlist("1k", "/different")) }),
    /net|connectivity/i,
  );
});

test("rejects selected resistor manufacturer data that disagrees with the circuit", () => {
  assertValidationModuleAvailable();
  const input = source();
  input.bom.items.find((item) => item.reference === "R1")
    .manufacturer_verified_properties.resistance_ohm = 3000;
  assert.throws(
    () => validation.assertCircuitMapping({ ...input, kicad: validation.parseKicadNetlist(netlist()) }),
    /R1.*resistance|resistance.*R1/i,
  );
});

test("rejects a selected manufacturer package that disagrees with the KiCad footprint", () => {
  assertValidationModuleAvailable();
  const input = source();
  input.bom.items.find((item) => item.reference === "C1")
    .manufacturer_verified_properties.package = "0805 / 2012 metric";
  assert.throws(
    () => validation.assertCircuitMapping({ ...input, kicad: validation.parseKicadNetlist(netlist()) }),
    /C1.*package|package.*C1/i,
  );
});

test("rejects a report directory on another Windows drive", () => {
  assert.throws(
    () => workspaceRelativePath("D:\\workspace", "E:\\outside\\reports", path.win32),
    /inside the repository workspace/,
  );
});

test("rejects overlapping KiCad template, generated-project, and report trees", () => {
  assert.equal(typeof workspacePaths.assertPathsDisjoint, "function");
  assert.doesNotThrow(() =>
    workspacePaths.assertPathsDisjoint({
      template: "D:\\repo\\integrations\\kicad",
      generated: "D:\\repo\\build\\kicad-generated",
      reports: "D:\\repo\\build\\kicad-validation",
    }, path.win32),
  );
  assert.throws(
    () =>
      workspacePaths.assertPathsDisjoint({
        template: "D:\\repo\\build\\kicad-validation\\fabrication\\template",
        generated: "D:\\repo\\build\\kicad-generated",
        reports: "D:\\repo\\build\\kicad-validation",
      }, path.win32),
    /paths must not overlap/i,
  );
});

test("rejects a report directory that escapes through a workspace symlink", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "edastack-path-test-"));
  const projectRoot = path.join(temporaryRoot, "repo");
  const outsideRoot = path.join(temporaryRoot, "outside");
  mkdirSync(projectRoot);
  mkdirSync(outsideRoot);
  const linkPath = path.join(projectRoot, "external");
  symlinkSync(outsideRoot, linkPath, process.platform === "win32" ? "junction" : "dir");

  try {
    assert.throws(
      () => workspaceRelativePath(projectRoot, path.join(linkPath, "reports")),
      /symbolic link outside the repository workspace/,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
