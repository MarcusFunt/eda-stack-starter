import assert from "node:assert/strict";
import { spiceValueInBaseUnits } from "./design-contract.mjs";

export function findFormEnd(text, start) {
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
  throw new Error("Unbalanced KiCad S-expression");
}

function decodeQuoted(value) {
  return JSON.parse(value);
}

function readSection(text, sectionName, parseForm) {
  const start = text.indexOf("(" + sectionName);
  assert.notEqual(start, -1, "KiCad netlist is missing its " + sectionName + " section");
  const end = findFormEnd(text, start);
  const section = text.slice(start, end);
  const result = {};
  let cursor = start + sectionName.length + 1;
  while (cursor < end) {
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    if (text[cursor] !== "(") break;
    const formEnd = findFormEnd(text, cursor);
    const parsed = parseForm(text.slice(cursor, formEnd));
    if (parsed) {
      assert.ok(!Object.hasOwn(result, parsed.key), "Duplicate KiCad " + sectionName + " entry: " + parsed.key);
      result[parsed.key] = parsed.value;
    }
    cursor = formEnd;
  }
  return result;
}

function quotedField(form, field, required = true) {
  const match = form.match(new RegExp("\\(" + field + "\\s+(\"(?:\\\\.|[^\"\\\\])*\")\\)"));
  if (!match) {
    if (!required) return null;
    throw new Error("KiCad netlist entry is missing " + field);
  }
  return decodeQuoted(match[1]);
}

export function parseKicadNetlist(text) {
  const components = readSection(text, "components", (form) => {
    if (!form.startsWith("(comp")) return null;
    const reference = quotedField(form, "ref");
    return {
      key: reference,
      value: {
        value: quotedField(form, "value"),
        footprint: quotedField(form, "footprint", false) ?? "",
      },
    };
  });
  const nets = readSection(text, "nets", (form) => {
    if (!form.startsWith("(net")) return null;
    const name = quotedField(form, "name");
    const nodes = [
      ...form.matchAll(
        /\(node\s+\(ref\s+("(?:\\.|[^"\\])*")\)\s+\(pin\s+("(?:\\.|[^"\\])*")\)/g,
      ),
    ]
      .map((match) => decodeQuoted(match[1]) + ":" + decodeQuoted(match[2]))
      .sort();
    return { key: name, value: nodes };
  });
  return {
    components: Object.fromEntries(Object.entries(components).sort()),
    nets: Object.fromEntries(Object.entries(nets).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function requireBOMItem(bom, reference) {
  const item = bom.items.find((candidate) => candidate.reference === reference);
  assert.ok(item, "BOM is missing " + reference);
  return item;
}

function assertNumericEqual(actual, expected, message) {
  const tolerance = Math.max(Math.abs(expected), Number.MIN_VALUE) * 1e-12;
  assert.ok(
    typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    message + "; expected " + expected + ", got " + actual,
  );
}

function assertBomPackage(reference, requirement, manufacturerPart, footprint) {
  for (const [label, value] of [
    ["BOM requirement", requirement],
    ["manufacturer part", manufacturerPart],
    ["KiCad footprint", footprint],
  ]) {
    assert.equal(typeof value, "string", reference + " " + label + " package is missing");
    for (const size of ["0603", "1608"]) {
      assert.ok(value.includes(size), reference + " " + label + " package does not match " + size);
    }
  }
}

function assertTscircuitSourceGraph(sourceManifest) {
  const components = sourceManifest.source_components;
  assert.ok(Array.isArray(components), "tscircuit source component list is missing");
  const componentShapes = components.map(({ name, ftype }) => `${name}:${ftype}`).sort();
  assert.deepEqual(
    componentShapes,
    ["C1:simple_capacitor", "R1:simple_resistor", "V1:simple_voltage_source"],
    "tscircuit source component set/types do not match the fixed RC fixture",
  );
  const componentById = new Map();
  const componentIds = new Set();
  for (const component of components) {
    assert.equal(typeof component.source_component_id, "string", "source component identity is missing");
    assert.equal(componentIds.has(component.source_component_id), false, "duplicate source component identity");
    componentIds.add(component.source_component_id);
    componentById.set(component.source_component_id, component.name);
  }

  const ports = sourceManifest.source_ports;
  assert.ok(Array.isArray(ports), "tscircuit source port list is missing");
  const portByKey = new Map();
  const portIds = new Set();
  const portShapes = [];
  for (const port of ports) {
    const componentName = componentById.get(port.source_component_id);
    assert.ok(componentName, "source port refers to an unknown component identity");
    assert.equal(typeof port.source_port_id, "string", "source port identity is missing");
    assert.equal(portIds.has(port.source_port_id), false, "duplicate source port identity");
    portIds.add(port.source_port_id);
    const key = componentName + "." + port.name;
    assert.equal(portByKey.has(key), false, "duplicate source component port " + key);
    portByKey.set(key, port.source_port_id);
    portShapes.push(key);
  }
  assert.deepEqual(
    portShapes.sort(),
    ["C1.pin1", "C1.pin2", "R1.pin1", "R1.pin2", "V1.pin1", "V1.pin2"],
    "tscircuit source ports do not match the fixed RC fixture",
  );

  const nets = sourceManifest.source_nets;
  assert.ok(Array.isArray(nets), "tscircuit source net list is missing");
  const netIds = new Set();
  const netByName = new Map();
  for (const net of nets) {
    assert.equal(typeof net.source_net_id, "string", "source net identity is missing");
    assert.equal(netIds.has(net.source_net_id), false, "duplicate source net identity");
    assert.equal(netByName.has(net.name), false, "duplicate source net name " + net.name);
    netIds.add(net.source_net_id);
    netByName.set(net.name, net.source_net_id);
  }
  assert.deepEqual([...netByName.keys()].sort(), ["GND", "in", "out"], "tscircuit source net set changed");

  const parent = new Map([...portIds, ...netIds].map((id) => [id, id]));
  const find = (id) => {
    const current = parent.get(id);
    assert.ok(current, "source trace refers to an unknown port/net identity");
    if (current !== id) parent.set(id, find(current));
    return parent.get(id);
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  assert.ok(Array.isArray(sourceManifest.source_traces), "tscircuit source trace list is missing");
  for (const trace of sourceManifest.source_traces) {
    const connected = [...(trace.connected_source_port_ids ?? []), ...(trace.connected_source_net_ids ?? [])];
    for (const id of connected) find(id);
    for (const id of connected.slice(1)) union(connected[0], id);
  }
  const expectedPortNets = [
    ["V1.pin1", "in"],
    ["R1.pin1", "in"],
    ["R1.pin2", "out"],
    ["C1.pin1", "out"],
    ["C1.pin2", "GND"],
    ["V1.pin2", "GND"],
  ];
  for (const [port, net] of expectedPortNets) {
    assert.equal(
      find(portByKey.get(port)),
      find(netByName.get(net)),
      "tscircuit source " + port + " must connect to named net " + net,
    );
  }
  assert.equal(new Set([find(netByName.get("in")), find(netByName.get("out")), find(netByName.get("GND"))]).size, 3,
    "tscircuit source input, output, and ground nets must be distinct");

  const sourceProbes = sourceManifest.source_probes;
  assert.ok(Array.isArray(sourceProbes), "tscircuit source probe list is missing");
  assert.deepEqual(sourceProbes.map((probe) => probe.name).sort(), ["VIN", "VOUT"]);
  const probeByName = new Map(sourceProbes.map((probe) => [probe.name, probe]));
  assert.equal(probeByName.get("VIN").signal_input_source_port_id, portByKey.get("V1.pin1"));
  assert.equal(probeByName.get("VOUT").signal_input_source_port_id, portByKey.get("C1.pin1"));
  assert.equal(probeByName.get("VIN").reference_input_source_net_id, netByName.get("GND"));
  assert.equal(probeByName.get("VOUT").reference_input_source_net_id, netByName.get("GND"));
}

export function assertRcSourceMapping({ design, sourceManifest }) {
  assert.equal(typeof design?.parameters?.resistance, "string", "RC design resistance is missing");
  assert.equal(typeof design?.parameters?.capacitance, "string", "RC design capacitance is missing");
  assert.equal(
    sourceManifest.source_values.resistance,
    design.parameters.resistance,
    "SPICE source value for resistance must match the design",
  );
  assert.equal(
    sourceManifest.source_values.capacitance,
    design.parameters.capacitance,
    "SPICE source value for capacitance must match the design",
  );
  assertTscircuitSourceGraph(sourceManifest);

  const spiceComponents = sourceManifest.spice_components;
  assert.ok(Array.isArray(spiceComponents), "SPICE source component list is missing");
  const names = spiceComponents.map((component) => component.name).sort();
  const voltageNames = names.filter((name) => name.startsWith("simulation_voltage_source_"));
  assert.equal(voltageNames.length, 1, "RC source must have exactly one simulation voltage source");
  const voltageName = voltageNames[0];
  assert.deepEqual(names, ["C1", "R1", voltageName].sort(), "SPICE component set does not match the RC source");
  const byName = new Map(spiceComponents.map((component) => [component.name, component]));
  const resistor = byName.get("R1");
  const capacitor = byName.get("C1");
  const voltage = byName.get(voltageName);
  assert.ok(resistor && capacitor && voltage);
  for (const [name, component] of [["R1", resistor], ["C1", capacitor], [voltageName, voltage]]) {
    assert.ok(Array.isArray(component.nodes), name + " node list is missing");
    assert.equal(component.nodes.length, 2, name + " must have two nodes");
  }
  assertNumericEqual(
    spiceValueInBaseUnits(resistor.statement.trim().split(/\s+/).at(-1)),
    spiceValueInBaseUnits(design.parameters.resistance),
    "SPICE R1 value does not match the design",
  );
  assertNumericEqual(
    spiceValueInBaseUnits(capacitor.statement.trim().split(/\s+/).at(-1)),
    spiceValueInBaseUnits(design.parameters.capacitance),
    "SPICE C1 value does not match the design",
  );
  const inputNode = voltage.nodes[0];
  const outputNode = resistor.nodes[1];
  const groundNode = voltage.nodes[1];
  assert.equal(resistor.nodes[0], inputNode, "SPICE input node topology changed");
  assert.equal(capacitor.nodes[0], outputNode, "SPICE output node topology changed");
  assert.equal(capacitor.nodes[1], groundNode, "SPICE ground node topology changed");
  assert.equal(groundNode, "0", "SPICE return must be ground");
  assert.equal(new Set([inputNode, outputNode, groundNode]).size, 3, "RC source nodes must be distinct");
  return { inputNode, outputNode, groundNode };
}

export function assertCircuitMapping({ design, sourceManifest, bom, kicad }) {
  const { inputNode, outputNode, groundNode } = assertRcSourceMapping({ design, sourceManifest });

  const resistorItem = requireBOMItem(bom, "R1");
  const capacitorItem = requireBOMItem(bom, "C1");
  const resistorProperties = resistorItem.manufacturer_verified_properties;
  const capacitorProperties = capacitorItem.manufacturer_verified_properties;
  assert.ok(resistorProperties && typeof resistorProperties === "object", "BOM R1 manufacturer data is missing");
  assert.ok(capacitorProperties && typeof capacitorProperties === "object", "BOM C1 manufacturer data is missing");
  assertNumericEqual(
    bom.requirements.R1.resistance_ohm,
    spiceValueInBaseUnits(design.parameters.resistance),
    "BOM R1 resistance requirement does not match the design",
  );
  assertNumericEqual(
    resistorProperties.resistance_ohm,
    spiceValueInBaseUnits(design.parameters.resistance),
    "BOM R1 manufacturer resistance does not match the design",
  );
  assert.ok(
    Number.isFinite(resistorProperties.tolerance_pct) &&
      resistorProperties.tolerance_pct >= 0 &&
      resistorProperties.tolerance_pct <= bom.requirements.R1.tolerance_pct_max,
    "BOM R1 manufacturer tolerance exceeds its requirement",
  );
  assertNumericEqual(
    bom.requirements.C1.capacitance_F,
    spiceValueInBaseUnits(design.parameters.capacitance),
    "BOM C1 capacitance requirement does not match the design",
  );
  assertNumericEqual(
    capacitorProperties.capacitance_F,
    spiceValueInBaseUnits(design.parameters.capacitance),
    "BOM C1 manufacturer capacitance does not match the design",
  );
  assert.ok(
    Number.isFinite(capacitorProperties.tolerance_pct) &&
      capacitorProperties.tolerance_pct >= 0 &&
      capacitorProperties.tolerance_pct <= bom.requirements.C1.tolerance_pct_max_at_25C,
    "BOM C1 manufacturer tolerance exceeds its requirement",
  );
  assertBomPackage(
    "R1",
    bom.requirements.R1.package,
    resistorProperties.package,
    resistorItem.footprint_and_pin_map?.footprint,
  );
  assertBomPackage(
    "C1",
    bom.requirements.C1.package,
    capacitorProperties.package,
    capacitorItem.footprint_and_pin_map?.footprint,
  );

  const expectedComponents = {
    R1: { value: design.parameters.resistance, footprint: "" },
    C1: { value: design.parameters.capacitance, footprint: "" },
    TP1: { value: "TP1", footprint: "TestPoint:TestPoint_Pad_D1.5mm" },
    TP2: { value: "TP2", footprint: "TestPoint:TestPoint_Pad_D1.5mm" },
    TP3: { value: "TP3", footprint: "TestPoint:TestPoint_Pad_D1.5mm" },
  };
  expectedComponents.R1.footprint = resistorItem.footprint_and_pin_map.footprint;
  expectedComponents.C1.footprint = capacitorItem.footprint_and_pin_map.footprint;
  assert.deepEqual(
    Object.keys(kicad.components).sort(),
    Object.keys(expectedComponents).sort(),
    "KiCad component set does not match the RC fixture",
  );
  for (const [reference, expected] of Object.entries(expectedComponents)) {
    const actual = kicad.components[reference];
    if (reference === "R1" || reference === "C1") {
      assertNumericEqual(
        spiceValueInBaseUnits(actual.value),
        spiceValueInBaseUnits(expected.value),
        reference + " value does not match the source/BOM",
      );
    } else {
      assert.equal(actual.value, expected.value, reference + " value does not match the source/BOM");
    }
    assert.equal(actual.footprint, expected.footprint, reference + " footprint does not match the BOM/fixture");
  }

  assert.deepEqual(kicad.nets, {
    "/in": ["R1:1", "TP1:1"],
    "/out": ["C1:1", "R1:2", "TP2:1"],
    GND: ["C1:2", "TP3:1"],
  }, "KiCad net connectivity does not match the RC source");
  return { inputNode, outputNode, groundNode };
}
