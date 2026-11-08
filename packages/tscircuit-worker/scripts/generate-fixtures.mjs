import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../..");
const integrationRoot = path.join(repositoryRoot, "integrations", "tscircuit-rc");
const integrationRequire = createRequire(path.join(integrationRoot, "package.json"));
const [reactModule, tscircuitModule] = await Promise.all([
  import(pathToFileURL(integrationRequire.resolve("react")).href),
  import(pathToFileURL(integrationRequire.resolve("tscircuit")).href),
]);
const React = reactModule.default ?? reactModule;
const { Circuit } = tscircuitModule;
const fixtureDir = path.join(here, "../fixtures");
await mkdir(fixtureDir, { recursive: true });

const rcBuilder = path.join(integrationRoot, "build-spice.mjs");
const rcOutput = path.join(repositoryRoot, "build", "tscircuit-worker", "rc-source");
const rcResult = spawnSync(process.execPath, [rcBuilder, "1k", "100n", rcOutput], {
  cwd: integrationRoot,
  encoding: "utf8",
  timeout: 120_000,
});
if (rcResult.error || rcResult.status !== 0) {
  throw new Error("Could not build Circuit JSON from the existing RC source: " + (rcResult.error?.message ?? rcResult.stderr));
}
const rcJson = await readFile(path.join(rcOutput, "circuit.json"));
await writeFile(path.join(fixtureDir, "rc.circuit.json"), rcJson);

const e = React.createElement;
async function writeFixture(filename, elements) {
  const circuit = new Circuit({ platform: { analogSimulationDisabled: true } });
  circuit.add(e("board", { width: 20, height: 20, routingDisabled: true, schTraceAutoLabelEnabled: true, schMaxTraceDistance: 2 }, ...elements));
  await circuit.renderUntilSettled();
  await writeFile(path.join(fixtureDir, filename), `${JSON.stringify(circuit.getCircuitJson(), null, 2)}\n`);
}

await writeFixture("two-resistor-labels.circuit.json", [
  e("net", { name: "VIN" }),
  e("net", { name: "SIGNAL" }),
  e("net", { name: "GND" }),
  e("resistor", { name: "R1", resistance: "1k", footprint: "0402", schX: 0, schY: 0, pcbX: 0, pcbY: 0 }),
  e("resistor", { name: "R2", resistance: "1k", footprint: "0402", schX: 5, schY: 0, pcbX: 5, pcbY: 0 }),
  e("trace", { from: ".R1 > .pin1", to: "net.VIN" }),
  e("trace", { from: ".R1 > .pin2", to: "net.SIGNAL" }),
  e("trace", { from: ".R2 > .pin1", to: "net.SIGNAL" }),
  e("trace", { from: ".R2 > .pin2", to: "net.GND" }),
]);

await writeFixture("power-rail.circuit.json", [
  e("net", { name: "V24", isPowerNet: true }),
  e("net", { name: "GND", isPowerNet: true }),
  e("capacitor", { name: "C1", capacitance: "220uF", footprint: "0603", schX: 0, schY: 0, pcbX: 0, pcbY: 0 }),
  e("capacitor", { name: "C2", capacitance: "100nF", footprint: "0603", schX: 5, schY: 0, pcbX: 5, pcbY: 0 }),
  e("trace", { from: ".C1 > .pin1", to: "net.V24" }),
  e("trace", { from: ".C1 > .pin2", to: "net.GND" }),
  e("trace", { from: ".C2 > .pin1", to: "net.V24" }),
  e("trace", { from: ".C2 > .pin2", to: "net.GND" }),
]);

process.stdout.write(JSON.stringify({ fixtures: ["rc", "two-resistor-labels", "power-rail"] }) + "\n");
