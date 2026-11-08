import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDesignSource } from "./design-contract.mjs";
import { resolvePython } from "./python-runtime.mjs";
import { assertElectricalFaultEvidence } from "./verification-acceptance.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");
const buildRoot = path.join(projectRoot, "build", "tscircuit-rc");
const sourceSpecPath = path.join(projectRoot, "examples", "rc_filter", "spec.json");
const python = resolvePython(projectRoot);

function runBuilder(resistance, capacitance, outputDir) {
  const result = spawnSync(
    process.execPath,
    [path.join(here, "build-spice.mjs"), resistance, capacitance, outputDir],
    { cwd: here, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`tscircuit build failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return outputDir;
}

function requireComponent(components, name) {
  const component = components.find((item) => item.name === name);
  assert.ok(component, `Missing converted SPICE component ${name}`);
  assert.equal(component.nodes.length, 2, `${name} must have two terminals`);
  return component;
}

function verifySourceToSpiceConnectivity(circuitJson, manifest) {
  const sourceComponents = new Map(
    manifest.source_components.map((component) => [component.source_component_id, component]),
  );
  const sourcePorts = new Map(
    manifest.source_ports.map((port) => [port.source_port_id, port]),
  );
  const portId = (componentName, portName) => {
    const match = manifest.source_ports.find((port) => {
      const component = sourceComponents.get(port.source_component_id);
      return component?.name === componentName && port.name === portName;
    });
    assert.ok(match, `Missing source port ${componentName}.${portName}`);
    return match.source_port_id;
  };

  const parent = new Map();
  const find = (value) => {
    if (!parent.has(value)) parent.set(value, value);
    const root = parent.get(value);
    if (root !== value) parent.set(value, find(root));
    return parent.get(value);
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const trace of circuitJson.filter((item) => item.type === "source_trace")) {
    const ids = [
      ...(trace.connected_source_port_ids ?? []),
      ...(trace.connected_source_net_ids ?? []),
    ];
    for (const id of ids.slice(1)) union(ids[0], id);
  }
  const sourceConnected = (left, right) => find(left) === find(right);

  const resistorPin1 = portId("R1", "pin1");
  const resistorPin2 = portId("R1", "pin2");
  const capacitorPin1 = portId("C1", "pin1");
  const capacitorPin2 = portId("C1", "pin2");
  const sourcePin1 = portId("V1", "pin1");
  const sourcePin2 = portId("V1", "pin2");
  assert.ok(sourceConnected(sourcePin1, resistorPin1), "source and resistor input pins must share a source net");
  assert.ok(sourceConnected(resistorPin2, capacitorPin1), "resistor output and capacitor signal pins must share a source net");
  assert.ok(sourceConnected(capacitorPin2, sourcePin2), "capacitor return and source return pins must share a source net");

  const resistor = requireComponent(manifest.spice_components, "R1");
  const capacitor = requireComponent(manifest.spice_components, "C1");
  const voltageSource = manifest.spice_components.find((item) => item.name.startsWith("simulation_voltage_source_"));
  assert.ok(voltageSource, "Missing converted voltage source");
  assert.equal(resistor.nodes[0], voltageSource.nodes[0], "source input must connect to resistor input in SPICE");
  assert.equal(resistor.nodes[1], capacitor.nodes[0], "resistor output must connect to capacitor signal in SPICE");
  assert.equal(capacitor.nodes[1], voltageSource.nodes[1], "capacitor return must connect to source return in SPICE");
  assert.equal(capacitor.nodes[1], "0", "source return must be SPICE ground");

  const sourceOutputProbe = manifest.source_probes.find((item) => item.name === "VOUT");
  assert.ok(sourceOutputProbe, "Missing VOUT source probe");
  assert.equal(sourceOutputProbe.signal_input_source_port_id, capacitorPin1, "VOUT probe must remain attached to the capacitor signal pin");
  const sourceInputProbe = manifest.source_probes.find((item) => item.name === "VIN");
  assert.ok(sourceInputProbe, "Missing VIN source probe");
  assert.equal(sourceInputProbe.signal_input_source_port_id, sourcePin1, "VIN probe must remain attached to the source input pin");
  const outputProbe = manifest.converted_probes.find((item) => item.name === "VOUT");
  const inputProbe = manifest.converted_probes.find((item) => item.name === "VIN");
  assert.ok(outputProbe?.source_node_name, "VOUT probe must resolve to a SPICE node");
  assert.ok(inputProbe?.source_node_name, "VIN probe must resolve to a SPICE node");
  assert.equal(outputProbe.source_node_name, capacitor.nodes[0], "VOUT probe must resolve to the capacitor signal node");
  assert.equal(inputProbe.source_node_name, voltageSource.nodes[0], "VIN probe must resolve to the source input node");

  return { inputNode: inputProbe.source_node_name, outputNode: outputProbe.source_node_name };
}

async function verifyNetlist(resistance, capacitance, tag, expectedPass, measurementIds = null) {
  const generatedDir = path.join(buildRoot, tag);
  runBuilder(resistance, capacitance, generatedDir);
  const [circuitJson, manifest, sourceSpec] = await Promise.all([
    readFile(path.join(generatedDir, "circuit.json"), "utf8").then(JSON.parse),
    readFile(path.join(generatedDir, "source-to-spice-manifest.json"), "utf8").then(JSON.parse),
    readFile(sourceSpecPath, "utf8").then(JSON.parse),
  ]);
  const { inputNode, outputNode } = verifySourceToSpiceConnectivity(circuitJson, manifest);

  sourceSpec.name = `tscircuit_${tag.replace(/-/g, "_")}`;
  sourceSpec.netlist = "generated.cir";
  sourceSpec.parameters = {};
  sourceSpec.scenarios = [{ name: "nominal", set: {} }];
  sourceSpec.measurements = sourceSpec.measurements
    .filter((measurement) => !measurementIds || measurementIds.includes(measurement.id))
    .map((measurement) => {
      const directiveById = {
        vin_peak: `meas tran vin_peak MAX v(${inputNode}) FROM=0u TO=400u`,
        vout_100u: `meas tran vout_100u FIND v(${outputNode}) AT=100u`,
        rise_time_10_90: `meas tran rise_time_10_90 TRIG v(${outputNode}) VAL=0.5 RISE=1 TARG v(${outputNode}) VAL=4.5 RISE=1`,
        vout_peak: `meas tran vout_peak MAX v(${outputNode}) FROM=0u TO=400u`,
      };
      return { ...measurement, directive: directiveById[measurement.id] };
    });
  const derivedSpec = path.join(generatedDir, "spec.json");
  await writeFile(derivedSpec, `${JSON.stringify(sourceSpec, null, 2)}\n`);
  const reportDir = path.join(buildRoot, "reports", tag);
  await mkdir(reportDir, { recursive: true });
  const result = spawnSync(
    python,
    ["-m", "edastack.cli", "verify", derivedSpec, "--out", reportDir],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: path.join(projectRoot, "src") },
    },
  );
  if (![0, 1].includes(result.status)) {
    throw new Error(`edastack verify failed to run (${result.status}): ${result.stderr || result.stdout}`);
  }
  const cliResult = JSON.parse(result.stdout);
  const report = await readFile(cliResult.report, "utf8").then(JSON.parse);
  if (expectedPass !== null) {
    assert.equal(report.passed, expectedPass, `${tag} expected passed=${expectedPass}; report: ${cliResult.report}`);
  }
  const scenario = report.scenarios.find((item) => item.scenario === "nominal");
  assert.ok(scenario, `${tag} report must contain the nominal scenario`);
  if (expectedPass === false) {
    assertElectricalFaultEvidence(scenario);
  }
  assert.equal(result.status, report.passed ? 0 : 1, `${tag} CLI exit code must signal its reported result`);

  return {
    resistance,
    capacitance,
    circuit_json_sha256: manifest.circuit_json_sha256,
    spice_sha256: manifest.spice_sha256,
    report: cliResult.report,
    run_id: report.run_id,
    ngspice_version: report.simulator_version,
    deck_sha256: scenario.deck_sha256,
    passed: report.passed,
    scenario: {
      status: scenario.status,
      passed: scenario.passed,
      returncode: scenario.returncode,
      timed_out: scenario.timed_out,
      errors: scenario.errors,
      checks: scenario.checks.map((item) => ({
        id: item.id,
        value: item.value,
        min: item.min,
        max: item.max,
        passed: item.passed,
      })),
    },
    checks: scenario.checks.map((item) => ({
      id: item.id,
      value: item.value,
      min: item.min,
      max: item.max,
      passed: item.passed,
    })),
  };
}

async function runCandidate(tag) {
  if (!/^[A-Za-z0-9_.-]+$/.test(tag)) throw new Error("candidate tag contains unsupported characters");
  const design = parseDesignSource(JSON.parse(await readFile(path.join(here, "design.json"), "utf8")));
  const result = await verifyNetlist(design.resistance, design.capacitance, tag, null);
  return { schema_version: 1, design, ...result };
}

async function runAcceptanceProof() {
  const design = parseDesignSource(JSON.parse(await readFile(path.join(here, "design.json"), "utf8")));
  const nominal = await verifyNetlist(design.resistance, design.capacitance, "nominal", true);
  const resistorFault = await verifyNetlist(
    "3k", design.capacitance, "resistor_fault", false, ["vin_peak", "vout_100u"]
  );
  const packageVersions = JSON.parse(await readFile(path.join(here, "package-lock.json"), "utf8")).packages;
  const summary = {
    schema_version: 1,
    source_revision: "generated from the tscircuit source in this package",
    design,
    package_versions: {
      tscircuit: packageVersions["node_modules/tscircuit"].version,
      circuit_json_to_spice: packageVersions["node_modules/circuit-json-to-spice"].version,
    },
    nominal,
    resistor_fault: { ...resistorFault, expected_failure: true },
  };
  const summaryPath = path.join(buildRoot, "verification-summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ summary: summaryPath, nominal, resistor_fault: summary.resistor_fault }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--candidate" && args[1]) {
      const result = await runCandidate(args[1]);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.passed ? 0 : 1;
    } else if (args.length === 0) {
      await runAcceptanceProof();
    } else {
      throw new Error("usage: node verify.mjs [--candidate <safe-tag>]");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
