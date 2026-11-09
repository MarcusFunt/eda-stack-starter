import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTypedCircuitIR } from "../src/typed-constraints.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const fixtureRoot = path.join(repositoryRoot, "benchmarks", "fixtures", "led-transistor");
const evidenceRoot = path.join(repositoryRoot, "benchmarks", "native-erc-inventory", "2026-11-09", "fixtures", "led-transistor");
const sourcePaths = ["src/board.tsx", "src/modules/low-side-led.tsx"];
const sourceFiles = await Promise.all(sourcePaths.map(async (relativePath) => ({
  path: relativePath,
  text: await readFile(path.join(fixtureRoot, ...relativePath.split("/")), "utf8"),
})));
const constraintsText = await readFile(path.join(fixtureRoot, "pcb.constraints.json"), "utf8");
sourceFiles.push({ path: "pcb.constraints.json", text: constraintsText });

const result = buildTypedCircuitIR({
  circuitJson: JSON.parse(await readFile(path.join(evidenceRoot, "project-build", "circuit.json"), "utf8")) as unknown[],
  pcbConstraints: JSON.parse(constraintsText) as unknown,
  sourceFiles,
});
const outputPath = path.join(packageRoot, "fixtures", "typed-constraints", "led-transistor.ir.json");
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
process.stdout.write("Wrote " + path.relative(repositoryRoot, outputPath).replaceAll("\\", "/") + "\n");
