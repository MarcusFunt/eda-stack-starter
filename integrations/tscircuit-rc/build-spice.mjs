import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { analog, Circuit } from "tscircuit";
import { circuitJsonToSpice } from "circuit-json-to-spice";
import { parseDesignSource, toTscircuitNumericLiteral } from "./design-contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");
const designPath = path.join(here, "design.json");
const designBytes = await readFile(designPath);
const design = parseDesignSource(JSON.parse(designBytes.toString("utf8")));
const [resistanceArgument, capacitanceArgument, outputArgument] = process.argv.slice(2);
const resistance = resistanceArgument || design.resistance;
const capacitance = capacitanceArgument || design.capacitance;
const tscircuitResistance = toTscircuitNumericLiteral(resistance);
const tscircuitCapacitance = toTscircuitNumericLiteral(capacitance);
const safe = (value) => value.replace(/[^A-Za-z0-9.-]/g, "_");
const outputDir = path.resolve(
  outputArgument ?? path.join(projectRoot, "build", "tscircuit-rc", `r-${safe(resistance)}-c-${safe(capacitance)}`),
);

const element = React.createElement;
// Keep tscircuit responsible for resolving Circuit JSON and SPICE topology.
// The EDA Stack runner performs the authoritative external ngspice simulation.
const circuit = new Circuit({ platform: { analogSimulationDisabled: true } });
circuit.add(
  element(
    "board",
    { routingDisabled: true },
    element("net", { name: "GND" }),
    element("net", { name: "in" }),
    element("net", { name: "out" }),
    element("voltagesource", {
      name: "V1",
      voltage: "5V",
      waveShape: "square",
      frequency: "500Hz",
      pulseDelay: "0ms",
      riseTime: "0.000001ms",
      fallTime: "0.000001ms",
      pulseWidth: "1ms",
      period: "2ms",
    }),
    element("resistor", { name: "R1", resistance: tscircuitResistance }),
    element("capacitor", { name: "C1", capacitance: tscircuitCapacitance }),
    element("trace", { from: ".V1 > .pin1", to: "net.in" }),
    element("trace", { from: ".R1 > .pin1", to: "net.in" }),
    element("trace", { from: ".R1 > .pin2", to: "net.out" }),
    element("trace", { from: ".C1 > .pin1", to: "net.out" }),
    element("trace", { from: ".C1 > .pin2", to: ".V1 > .pin2" }),
    element("trace", { from: ".V1 > .pin2", to: "net.GND" }),
    element(analog.transientsimulation, {
      name: "RC transient",
      duration: "0.4ms",
      timePerStep: "0.2us",
      spiceEngine: "ngspice",
    }),
    element("voltageprobe", {
      name: "VOUT",
      connectsTo: ".C1 > .pin1",
      referenceTo: "net.GND",
    }),
    element("voltageprobe", {
      name: "VIN",
      connectsTo: ".V1 > .pin1",
      referenceTo: "net.GND",
    }),
  ),
);

await circuit.renderUntilSettled();
const circuitJson = circuit.getCircuitJson();
const spiceNetlist = circuitJsonToSpice(circuitJson);
const spiceText = spiceNetlist.toSpiceString();
const source = await readFile(fileURLToPath(import.meta.url));
const packageLock = JSON.parse(await readFile(path.join(here, "package-lock.json"), "utf8"));
const manifest = {
  schema_version: 1,
  source_file: "integrations/tscircuit-rc/build-spice.mjs",
  source_sha256: createHash("sha256").update(source).digest("hex"),
  design_source_file: "integrations/tscircuit-rc/design.json",
  design_source_sha256: createHash("sha256").update(designBytes).digest("hex"),
  package_versions: {
    tscircuit: packageLock.packages["node_modules/tscircuit"].version,
    circuit_json_to_spice: packageLock.packages["node_modules/circuit-json-to-spice"].version,
  },
  source_values: { resistance, capacitance },
  tscircuit_input_values: { resistance: tscircuitResistance, capacitance: tscircuitCapacitance },
  source_components: circuitJson
    .filter((item) => item.type === "source_component")
    .map(({ source_component_id, name, ftype, ...item }) => ({
      source_component_id,
      name,
      ftype,
      properties: item.properties,
    })),
  source_ports: circuitJson
    .filter((item) => item.type === "source_port")
    .map(({ source_port_id, source_component_id, name, ...item }) => ({
      source_port_id,
      source_component_id,
      name,
      connected_source_net_ids: item.connected_source_net_ids,
    })),
  source_nets: circuitJson
    .filter((item) => item.type === "source_net")
    .map(({ source_net_id, name }) => ({ source_net_id, name })),
  source_traces: circuitJson
    .filter((item) => item.type === "source_trace")
    .map(({ source_trace_id, connected_source_port_ids, connected_source_net_ids }) => ({
      source_trace_id,
      connected_source_port_ids,
      connected_source_net_ids,
    })),
  source_probes: circuitJson
    .filter((item) => item.type === "simulation_voltage_probe")
    .map(({ simulation_voltage_probe_id, name, signal_input_source_port_id, reference_input_source_net_id }) => ({
      simulation_voltage_probe_id,
      name,
      signal_input_source_port_id,
      reference_input_source_net_id,
    })),
  converted_probes: [...spiceText.matchAll(/^\* tscircuit_probe (.+)$/gm)]
    .map((match) => JSON.parse(match[1])),
  spice_components: spiceNetlist.components.map((component) => ({
    name: component.name,
    nodes: component.nodes,
    statement: component.toSpiceString(),
  })),
  circuit_json_sha256: createHash("sha256").update(JSON.stringify(circuitJson)).digest("hex"),
  spice_sha256: createHash("sha256").update(spiceText).digest("hex"),
};

await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "circuit.json"), `${JSON.stringify(circuitJson, null, 2)}\n`);
await writeFile(path.join(outputDir, "generated.cir"), spiceText);
await writeFile(path.join(outputDir, "source-to-spice-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ outputDir, spiceText, manifest }, null, 2)}\n`);
