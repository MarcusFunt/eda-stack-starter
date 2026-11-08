import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportCircuitJsonToKicad } from "./export-kicad.js";

const [inputArgument, outputArgument, projectName] = process.argv.slice(2);
if (!inputArgument || !outputArgument || !projectName) {
  throw new Error("Usage: npm run export -- <circuit.json> <output-directory> <project-name>");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const inputPath = path.resolve(inputArgument);
const circuitJson = JSON.parse(await readFile(inputPath, "utf8")) as unknown[];
const result = await exportCircuitJsonToKicad({ circuitJson, outputDir: outputArgument, projectName });
process.stdout.write(
  JSON.stringify({ input: inputPath, output: result.outputDir, files: result.files, circuit_json_sha256: result.circuitJsonSha256 }, null, 2) +
    "\n",
);
